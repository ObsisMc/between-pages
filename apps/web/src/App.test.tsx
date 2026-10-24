import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App.tsx';
import { ApiError, callApi } from './api/client.ts';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderApp() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
}

describe('App', () => {
  it('shows the service as healthy when the API answers the contract', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ status: 'ok' })),
    );
    renderApp();
    expect(await screen.findByText('服务正常')).toBeDefined();
  });

  it('shows the service as unavailable when the API fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 503 })),
    );
    renderApp();
    expect(await screen.findByText('服务暂不可用')).toBeDefined();
  });
});

describe('callApi', () => {
  it('rejects a response that does not match the contract', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ status: 'degraded' }));
    await expect(callApi('health', fetchImpl)).rejects.toThrow();
  });

  it('reports the HTTP status of a failed call', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 401 }));
    await expect(callApi('health', fetchImpl)).rejects.toMatchObject(new ApiError('health', 401));
  });
});
