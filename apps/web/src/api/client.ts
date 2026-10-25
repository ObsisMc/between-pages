import {
  ApiErrorBody,
  routes,
  type ErrorCode,
  type ResponseOf,
  type RouteName,
} from '@between-pages/contracts';

export class ApiError extends Error {
  readonly status: number;
  /** From the contract error body; `INTERNAL` when the body is missing or unreadable. */
  readonly code: ErrorCode;
  constructor(route: RouteName, status: number, code: ErrorCode) {
    super(`${route} failed with HTTP ${status} (${code})`);
    this.status = status;
    this.code = code;
  }
}

// The only way the web app calls the API: path, method and response parsing all come
// from the shared contract, so a server change that breaks the shape fails here loudly.
// The single exception is Better Auth's own endpoints in ./auth.ts.
export async function callApi<Name extends RouteName>(
  name: Name,
  fetchImpl: typeof fetch = fetch,
): Promise<ResponseOf<Name>> {
  const route = routes[name];
  const res = await fetchImpl(route.path, { method: route.method });
  if (!res.ok) throw new ApiError(name, res.status, await errorCode(res));
  return route.response.parse(await res.json()) as ResponseOf<Name>;
}

async function errorCode(res: Response): Promise<ErrorCode> {
  try {
    return ApiErrorBody.parse(await res.json()).error.code;
  } catch {
    return 'INTERNAL';
  }
}
