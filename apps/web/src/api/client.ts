import {
  ApiErrorBody,
  routes,
  type BodyOf,
  type ErrorCode,
  type ParamsOf,
  type QueryOf,
  type ResponseOf,
  type RouteName,
} from '@between-pages/contracts';

export class ApiError extends Error {
  readonly status: number;
  /** From the contract error body; `INTERNAL` when the body is missing or unreadable. */
  readonly code: ErrorCode;
  /** `SHARE_OPEN_FAILED` only: the diary dates that could not be opened. */
  readonly dates: string[];
  constructor(route: RouteName, status: number, code: ErrorCode, dates: string[] = []) {
    super(`${route} failed with HTTP ${status} (${code})`);
    this.status = status;
    this.code = code;
    this.dates = dates;
  }
}

type Field<Key extends string, Value> = undefined extends Value
  ? { [K in Key]?: never }
  : { [K in Key]: Value };

/** What a route takes besides its name: exactly the inputs its contract entry declares. */
export type RequestOf<Name extends RouteName> = Field<'params', ParamsOf<Name>> &
  Field<'query', QueryOf<Name>> &
  Field<'body', BodyOf<Name>>;

type CallArgs<Name extends RouteName> = [ParamsOf<Name>, QueryOf<Name>, BodyOf<Name>] extends [
  undefined,
  undefined,
  undefined,
]
  ? [request?: RequestOf<Name>, fetchImpl?: typeof fetch]
  : [request: RequestOf<Name>, fetchImpl?: typeof fetch];

// The only way the web app calls the API: path, method and response parsing all come
// from the shared contract, so a server change that breaks the shape fails here loudly.
// The single exception is Better Auth's own endpoints in ./auth.ts.
export async function callApi<Name extends RouteName>(
  name: Name,
  ...[request, fetchImpl = fetch]: CallArgs<Name>
): Promise<ResponseOf<Name>> {
  const route = routes[name];
  const { params, query, body } = (request ?? {}) as {
    params?: Record<string, string>;
    query?: Record<string, string | undefined>;
    body?: unknown;
  };
  let url: string = route.path.replace(/:(\w+)/g, (_, key: string) =>
    encodeURIComponent(params?.[key] ?? ''),
  );
  const search = new URLSearchParams(
    Object.entries(query ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  ).toString();
  if (search) url += `?${search}`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: route.method,
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
  } catch (error) {
    if (noAnswer(error)) setReachable(false);
    throw error;
  }
  setReachable(true);
  if (!res.ok) {
    const { code, dates } = await errorOf(res);
    throw new ApiError(name, res.status, code, dates);
  }
  return route.response.parse(await res.json()) as ResponseOf<Name>;
}

async function errorOf(res: Response): Promise<{ code: ErrorCode; dates?: string[] | undefined }> {
  try {
    return ApiErrorBody.parse(await res.json()).error;
  } catch {
    return { code: 'INTERNAL' };
  }
}

/** Whether a call failed without any HTTP answer: `fetch` rejects with a `TypeError` then. */
export const noAnswer = (error: unknown): boolean => error instanceof TypeError;

// installable-pwa D4: whether the API answers at all, for display only. Every callApi result
// sets it: any HTTP answer, an error included, is online; no answer is offline. The browser's
// `offline` is believed at once, its `online` only after the API answers a probe, since it is
// also true on a network that reaches nothing. Nothing that saves or sends reads it.
const PROBE_MS = 10_000;
const browserOnline = () => navigator.onLine !== false;
let reachable = true;
let probe: ReturnType<typeof setInterval> | undefined;
const watchers = new Set<() => void>();

function setReachable(next: boolean) {
  if (next === reachable) return;
  reachable = next;
  keepProbing();
  for (const watcher of watchers) watcher();
}

function keepProbing() {
  const wanted = !reachable && watchers.size > 0;
  if (wanted && !probe) probe = setInterval(check, PROBE_MS);
  if (!wanted && probe) {
    clearInterval(probe);
    probe = undefined;
  }
}

const check = () => void callApi('health').catch(() => undefined);
const wentOffline = () => setReachable(false);

export const isReachable = () => reachable;

/**
 * Hears every change of `isReachable()`. While anyone watches, the browser's events count and
 * an unreachable API is probed every 10 s; with nobody watching, nothing shows the state, so
 * the next watcher starts again from the browser's word.
 */
export function watchReachable(watcher: () => void): () => void {
  if (watchers.size === 0) {
    reachable = browserOnline();
    window.addEventListener('offline', wentOffline);
    window.addEventListener('online', check);
  }
  watchers.add(watcher);
  keepProbing();
  return () => {
    watchers.delete(watcher);
    if (watchers.size > 0) return;
    window.removeEventListener('offline', wentOffline);
    window.removeEventListener('online', check);
    reachable = true;
    keepProbing();
  };
}
