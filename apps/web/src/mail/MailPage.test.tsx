import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderAt, signedIn, signedOut, stubApi } from '../../test/render.tsx';
import { MailHint } from './MailHint.tsx';
import { MailPage } from './MailPage.tsx';
import { UnsubscribePage } from './UnsubscribePage.tsx';

// The email reminder pages (email-reminders D8).

const settings = (over: object = {}) => ({
  mail: {
    newContent: true,
    anniversary: true,
    backup: true,
    address: 'alice@example.com',
    hintDismissed: false,
    ...over,
  },
});
const bodyOf = (init?: RequestInit) => JSON.parse(String(init?.body));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('MailPage', () => {
  it('shows the three switches, the address and the fixed preview notice, and saves one switch', async () => {
    const fetch = stubApi({
      'GET /api/me': signedIn(),
      'GET /api/mail': () => Response.json(settings()),
      'PUT /api/mail': (init) => Response.json(settings(bodyOf(init))),
    });
    renderAt('/mail', [{ path: '/mail', element: <MailPage /> }]);
    const newContent = await screen.findByRole('switch', { name: '有新内容' });
    expect(newContent.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('switch', { name: '纪念日' })).toBeDefined();
    expect(screen.getByRole('switch', { name: '备份' })).toBeDefined();
    expect(screen.getByText('alice@example.com')).toBeDefined();
    expect(
      screen.getByText(
        '你写的字可能以约 50 字的预览出现在 TA 的提醒邮件里，发出后删改不会同步到邮件。',
      ),
    ).toBeDefined();

    fireEvent.click(newContent);
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: '有新内容' }).getAttribute('aria-checked')).toBe(
        'false',
      ),
    );
    const put = fetch.mock.calls.find(([, init]) => init?.method === 'PUT')!;
    expect(bodyOf(put[1])).toEqual({ newContent: false });
    expect(screen.getByRole('switch', { name: '纪念日' }).getAttribute('aria-checked')).toBe(
      'true',
    );
  });

  it('says so when saving fails and keeps the switch as the server has it', async () => {
    stubApi({
      'GET /api/me': signedIn(),
      'GET /api/mail': () => Response.json(settings()),
      'PUT /api/mail': () => new Response(null, { status: 500 }),
    });
    renderAt('/mail', [{ path: '/mail', element: <MailPage /> }]);
    fireEvent.click(await screen.findByRole('switch', { name: '备份' }));
    expect((await screen.findByRole('alert')).textContent).toBe('没能保存，请稍后再试');
    expect(screen.getByRole('switch', { name: '备份' }).getAttribute('aria-checked')).toBe('true');
  });
});

describe('UnsubscribePage', () => {
  it('[adr:email-reminders#9] asks before unsubscribing and posts only on the button, signed out', async () => {
    const fetch = stubApi({
      'GET /api/me': signedOut,
      'GET /api/mail/unsubscribe/category?token=tok': () =>
        Response.json({ category: 'new_content' }),
      'POST /api/mail/unsubscribe?token=tok': () =>
        Response.json({ category: 'new_content', unsubscribed: true }),
    });
    renderAt('/unsubscribe?token=tok', [{ path: '/unsubscribe', element: <UnsubscribePage /> }]);
    expect(await screen.findByText('不再收到「有新内容」邮件？')).toBeDefined();
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '不再收到' }));
    expect((await screen.findByRole('status')).textContent).toContain('已退订「有新内容」邮件。');
    const post = fetch.mock.calls.find(([, init]) => init?.method === 'POST')!;
    expect(bodyOf(post[1])).toEqual({});
  });

  it('says an unknown link is invalid, and so is one without a token', async () => {
    stubApi({
      'GET /api/mail/unsubscribe/category?token=bad': () =>
        Response.json({ error: { code: 'NOT_FOUND', message: 'x' } }, { status: 404 }),
    });
    renderAt('/unsubscribe?token=bad', [{ path: '/unsubscribe', element: <UnsubscribePage /> }]);
    expect((await screen.findByRole('alert')).textContent).toContain('这个退订链接无效');
    cleanup();
    stubApi({});
    renderAt('/unsubscribe', [{ path: '/unsubscribe', element: <UnsubscribePage /> }]);
    expect((await screen.findByRole('alert')).textContent).toContain('这个退订链接无效');
  });
});

describe('MailHint', () => {
  it('tells once that reminders are on, and closing it is remembered by the server', async () => {
    const fetch = stubApi({
      'GET /api/mail': () => Response.json(settings()),
      'PUT /api/mail': (init) =>
        Response.json(settings({ hintDismissed: bodyOf(init).dismissHint })),
    });
    renderAt('/', [{ path: '/', element: <MailHint /> }]);
    expect((await screen.findByRole('status')).textContent).toContain(
      '邮件提醒已开启，可在设置里关闭',
    );
    fireEvent.click(screen.getByRole('button', { name: '不再显示' }));
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    const put = fetch.mock.calls.find(([, init]) => init?.method === 'PUT')!;
    expect(bodyOf(put[1])).toEqual({ dismissHint: true });
  });

  it('shows nothing once closed', async () => {
    const fetch = stubApi({
      'GET /api/mail': () => Response.json(settings({ hintDismissed: true })),
    });
    renderAt('/', [{ path: '/', element: <MailHint /> }]);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByRole('status')).toBeNull();
  });
});
