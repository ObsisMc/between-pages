import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderAt, signedIn, signedOut, stubApi } from '../../test/render.tsx';
import { LoginPage, loginErrorText } from './LoginPage.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('login error messages', () => {
  it.each([
    [
      'account_not_linked',
      '这个 Google 账号的邮箱已被另一个账号使用。请换一个 Google 账号登录，或联系我们处理。',
    ],
    ['access_denied', '你取消了 Google 授权，需要授权才能登录。'],
    ['state_mismatch', '登录已过期，请重新登录。'],
    ['invalid_callback_request', '登录已过期，请重新登录。'],
    ['no_code', '登录已过期，请重新登录。'],
    ['something_else', '登录没有成功，请重试。'],
  ])('shows the message for ?error=%s on the page', async (code, text) => {
    stubApi({ 'GET /api/me': signedOut });
    renderAt(`/login?error=${code}`);
    expect((await screen.findByRole('alert')).textContent).toBe(text);
    expect(loginErrorText(code)).toBe(text);
  });

  it('shows no message without ?error', async () => {
    stubApi({ 'GET /api/me': signedOut });
    renderAt('/login');
    await screen.findByText('使用 Google 登录');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('login actions', () => {
  const withGoTo = (goTo: (url: string) => void) => [
    { path: '/login', element: <LoginPage goTo={goTo} /> },
  ];

  it('sends the browser to Google and disables the button meanwhile', async () => {
    const goTo = vi.fn();
    stubApi({
      'GET /api/me': signedOut,
      'POST /api/auth/sign-in/social': () =>
        Response.json({ url: 'https://accounts.google.com/o' }),
    });
    renderAt('/login', withGoTo(goTo));
    fireEvent.click(await screen.findByText('使用 Google 登录'));
    expect(screen.getByText('正在前往 Google…').closest('button')!.disabled).toBe(true);
    await waitFor(() => expect(goTo).toHaveBeenCalledWith('https://accounts.google.com/o'));
  });

  it('says the login service is unreachable when starting fails', async () => {
    stubApi({
      'GET /api/me': signedOut,
      'POST /api/auth/sign-in/social': () => new Response(null, { status: 503 }),
    });
    renderAt('/login', withGoTo(vi.fn()));
    fireEvent.click(await screen.findByText('使用 Google 登录'));
    expect((await screen.findByRole('alert')).textContent).toBe('无法连接登录服务，请稍后再试');
    expect(screen.getByText('使用 Google 登录').closest('button')!.disabled).toBe(false);
  });

  it('signs in through the development provider with the typed name', async () => {
    const goTo = vi.fn();
    const fetchMock = stubApi({
      'GET /api/me': signedOut,
      'POST /api/auth/sign-in/social': () =>
        Response.json({ url: 'http://127.0.0.1:4010/authorize' }),
    });
    renderAt('/login', withGoTo(goTo));
    fireEvent.change(await screen.findByLabelText('开发登录'), { target: { value: ' bob ' } });
    fireEvent.click(screen.getByRole('button', { name: '开发登录' }));
    await waitFor(() => expect(goTo).toHaveBeenCalledWith('http://127.0.0.1:4010/authorize'));
    const body = JSON.parse(fetchMock.mock.calls[1]![1]!.body as string);
    expect(body).toMatchObject({ provider: 'dev', loginHint: 'bob' });
  });

  it('[adr:installable-pwa#3] does not leave for Google while offline, and says so until the API answers', async () => {
    const goTo = vi.fn();
    let online = false;
    stubApi({
      'GET /api/me': () =>
        online ? signedOut() : Promise.reject(new TypeError('Failed to fetch')),
      'GET /api/health': () => Response.json({ status: 'ok' }),
    });
    renderAt('/login', withGoTo(goTo));
    expect((await screen.findByRole('status')).textContent).toBe('现在离线，联网后再登录');
    const google = screen.getByText('使用 Google 登录').closest('button')!;
    expect(google.disabled).toBe(true);
    fireEvent.click(google);
    expect(goTo).not.toHaveBeenCalled();

    online = true;
    window.dispatchEvent(new Event('online'));
    await waitFor(() => expect(google.disabled).toBe(false));
    expect(screen.queryByText('现在离线，联网后再登录')).toBeNull();
  });

  it('sends a signed-in user to the home page', async () => {
    stubApi({ 'GET /api/me': signedIn() });
    const { router } = renderAt('/login');
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
  });
});
