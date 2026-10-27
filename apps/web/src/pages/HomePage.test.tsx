import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderAt, signedIn, signedOut, stubApi } from '../../test/render.tsx';

const diary = {
  diaryId: '7c1d2b8e-3f4a-4b5c-8d6e-9f0a1b2c3d4e',
  diaryDate: '2026-10-05',
  ownerId: '6f1c1d0e-0000-4000-8000-000000000001',
  generationId: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
  seq: 0,
  state: '',
  bindings: [],
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('HomePage', () => {
  it('signs out, forgets the session and returns to /login', async () => {
    let session = true;
    stubApi({
      'GET /api/me': () => (session ? signedIn('alice')() : signedOut()),
      'POST /api/auth/sign-out': () => ((session = false), Response.json({ success: true })),
    });
    const { router, client } = renderAt('/');
    fireEvent.click(await screen.findByText('退出'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(await screen.findByText('使用 Google 登录')).toBeDefined();
    expect(client.getQueryData(['me'])).toBeUndefined();
  });

  it('stays and says so when signing out fails', async () => {
    stubApi({
      'GET /api/me': signedIn('alice'),
      'POST /api/auth/sign-out': () => new Response(null, { status: 500 }),
    });
    const { router } = renderAt('/');
    fireEvent.click(await screen.findByText('退出'));
    expect((await screen.findByRole('alert')).textContent).toBe('退出失败，请重试');
    expect(router.state.location.pathname).toBe('/');
  });

  it('opens today in the device time zone and goes to that diary', async () => {
    const opened = vi.fn((init: RequestInit | undefined) => {
      void init;
      return Response.json({ created: true, diary: { ...diary, diaryDate: '2026-10-27' } });
    });
    stubApi({ 'GET /api/me': signedIn('alice'), 'POST /api/diaries': opened });
    const { router } = renderAt('/');
    fireEvent.click(await screen.findByText('写今天'));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/diaries/${diary.diaryId}`));
    expect(JSON.parse(String(opened.mock.calls[0]![0]?.body))).toEqual({
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
  });

  it('opens a past date the user picks', async () => {
    const opened = vi.fn((init: RequestInit | undefined) => {
      void init;
      return Response.json({ created: true, diary });
    });
    stubApi({ 'GET /api/me': signedIn('alice'), 'POST /api/diaries': opened });
    const { router } = renderAt('/');
    fireEvent.change(await screen.findByLabelText('打开或补写过去的日期'), {
      target: { value: '2026-10-05' },
    });
    fireEvent.click(screen.getByText('打开'));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/diaries/${diary.diaryId}`));
    expect(JSON.parse(String(opened.mock.calls[0]![0]?.body))).toMatchObject({
      date: '2026-10-05',
    });
  });

  it('does not claim to open today while offline', async () => {
    stubApi({
      'GET /api/me': signedIn('alice'),
      'POST /api/diaries': () => Promise.reject(new TypeError('Failed to fetch')),
    });
    const { router } = renderAt('/');
    fireEvent.click(await screen.findByText('写今天'));
    expect((await screen.findByRole('alert')).textContent).toBe(
      '离线时无法确认要打开的日记，请联网后再试',
    );
    expect(router.state.location.pathname).toBe('/');
  });
});
