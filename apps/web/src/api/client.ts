import { routes, type ResponseOf, type RouteName } from '@between-pages/contracts';

export class ApiError extends Error {
  readonly status: number;
  constructor(route: RouteName, status: number) {
    super(`${route} failed with HTTP ${status}`);
    this.status = status;
  }
}

// The only way the web app calls the API: path, method and response parsing all come
// from the shared contract, so a server change that breaks the shape fails here loudly.
export async function callApi<Name extends RouteName>(
  name: Name,
  fetchImpl: typeof fetch = fetch,
): Promise<ResponseOf<Name>> {
  const route = routes[name];
  const res = await fetchImpl(route.path, { method: route.method });
  if (!res.ok) throw new ApiError(name, res.status);
  return route.response.parse(await res.json()) as ResponseOf<Name>;
}
