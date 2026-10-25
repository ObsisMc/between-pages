import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, callApi } from './client.ts';

afterEach(() => vi.unstubAllGlobals());

describe('callApi', () => {
  it('rejects a response that does not match the contract', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ status: 'degraded' }));
    await expect(callApi('health', fetchImpl)).rejects.toThrow();
  });

  it('reports the HTTP status and contract error code of a failed call', async () => {
    const body = { error: { code: 'UNAUTHENTICATED', message: 'Sign in required' } };
    const fetchImpl = vi.fn(async () => Response.json(body, { status: 401 }));
    await expect(callApi('me', fetchImpl)).rejects.toMatchObject({
      status: 401,
      code: 'UNAUTHENTICATED',
    });
  });

  it('falls back to INTERNAL when the error body is not the contract shape', async () => {
    const fetchImpl = vi.fn(async () => new Response('Bad gateway', { status: 502 }));
    const error = await callApi('health', fetchImpl).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 502, code: 'INTERNAL' });
  });
});
