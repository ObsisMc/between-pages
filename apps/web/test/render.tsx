import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider, type RouteObject } from 'react-router';
import { vi } from 'vitest';
import { appRoutes } from '../src/routes.tsx';

type Handler = (init: RequestInit | undefined) => Response | Promise<Response>;

/** Stubs fetch with one handler per "METHOD path"; unknown calls fail the test loudly. */
export function stubApi(handlers: Record<string, Handler>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input)}`;
    const handler = handlers[key];
    if (!handler) throw new Error(`unexpected request ${key}`);
    return handler(init);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

export const signedOut = () =>
  Response.json(
    { error: { code: 'UNAUTHENTICATED', message: 'Sign in required' } },
    { status: 401 },
  );
export const signedIn =
  (displayName = 'alice') =>
  () =>
    Response.json({ user: { id: '6f1c1d0e-0000-4000-8000-000000000001', displayName } });

/** Renders the real routes at `path` with a fresh, no-delay query client. */
export function renderAt(path: string, routes: RouteObject[] = appRoutes) {
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, client };
}

/** The home page's relationship section with no space and no invitation. */
export const noRelationship = {
  'GET /api/binding': () => Response.json({ binding: null, invitation: null }),
  'GET /api/spaces': () => Response.json({ spaces: [] }),
};
