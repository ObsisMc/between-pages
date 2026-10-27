import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, callApi } from './client.ts';

afterEach(() => vi.unstubAllGlobals());

describe('callApi', () => {
  it('rejects a response that does not match the contract', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ status: 'degraded' }));
    await expect(callApi('health', {}, fetchImpl)).rejects.toThrow();
  });

  it('reports the HTTP status and contract error code of a failed call', async () => {
    const body = { error: { code: 'UNAUTHENTICATED', message: 'Sign in required' } };
    const fetchImpl = vi.fn(async () => Response.json(body, { status: 401 }));
    await expect(callApi('me', {}, fetchImpl)).rejects.toMatchObject({
      status: 401,
      code: 'UNAUTHENTICATED',
    });
  });

  it('falls back to INTERNAL when the error body is not the contract shape', async () => {
    const fetchImpl = vi.fn(async () => new Response('Bad gateway', { status: 502 }));
    const error = await callApi('health', {}, fetchImpl).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 502, code: 'INTERNAL' });
  });

  it('fills path parameters and the query from the request', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ receipt: null }));
    const diaryId = '7c1d2b8e-3f4a-4b5c-8d6e-9f0a1b2c3d4e';
    const batchId = '0e9d8c7b-6a5f-4e3d-9c2b-1a0f9e8d7c6b';
    await expect(
      callApi('receipt', { params: { diaryId }, query: { batchId } }, fetchImpl),
    ).resolves.toEqual({ receipt: null });
    expect(fetchImpl).toHaveBeenCalledWith(`/api/diaries/${diaryId}/receipt?batchId=${batchId}`, {
      method: 'GET',
    });
  });

  it('sends the body as JSON', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({ error: { code: 'VALIDATION_FAILED', message: 'bad' } }, { status: 400 }),
    );
    await callApi('openDiary', { body: { timezone: 'Asia/Shanghai' } }, fetchImpl).catch(
      () => undefined,
    );
    expect(fetchImpl).toHaveBeenCalledWith('/api/diaries', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"timezone":"Asia/Shanghai"}',
    });
  });
});
