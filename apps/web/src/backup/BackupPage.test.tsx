import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderAt, signedIn, stubApi } from '../../test/render.tsx';
import { BackupBanner } from './BackupBanner.tsx';
import { BackupPage } from './BackupPage.tsx';
import { GoogleCallbackPage } from './GoogleCallbackPage.tsx';

const google = (state: string, extra: object = {}) => ({
  backup: {
    google: { state, email: null, connectedAt: null, expiresAt: null, retrying: false, ...extra },
    progress: null,
    attention: null,
    events: [],
  },
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const routesWith = (goTo: (url: string) => void) => [
  {
    path: '/backup',
    element: <BackupPage goTo={goTo} />,
  },
  {
    path: '/backup/google/callback',
    element: <GoogleCallbackPage />,
  },
  { path: '/', element: <p>home</p> },
];

describe('BackupPage', () => {
  it('[adr:server-backup-and-google-docs#13] starts connecting and sends the browser to Google', async () => {
    const goTo = vi.fn();
    stubApi({
      'GET /api/me': signedIn(),
      'GET /api/backup': () => Response.json(google('disconnected')),
      'POST /api/backup/google/start': () =>
        Response.json({ url: 'https://accounts.google.com/o/oauth2/v2/auth?state=s' }),
    });
    renderAt('/backup', routesWith(goTo));
    expect(await screen.findByText('未开启 Google 备份')).toBeDefined();
    fireEvent.click(screen.getByText('连接 Google Drive'));
    await waitFor(() =>
      expect(goTo).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/v2/auth?state=s'),
    );
  });

  it('keeps where the Docs are behind an icon that opens on hover and on keyboard focus, before and after connecting (F-07)', async () => {
    const PATH = '我的云端硬盘 › Between Pages › 年 › 月';
    const shown = () => {
      const text = screen.getByText(PATH).parentElement!.textContent!;
      expect(text).toContain('可以在 Drive 里移动或改名 Between Pages 文件夹，备份会跟着它');
      expect(text).toContain('删掉的话会在根目录重新建一个');
    };
    stubApi({
      'GET /api/me': signedIn(),
      'GET /api/backup': () => Response.json(google('disconnected')),
    });
    renderAt('/backup', routesWith(vi.fn()));
    expect(await screen.findByText('未开启 Google 备份')).toBeDefined();
    expect(screen.queryByText(PATH)).toBeNull();
    fireEvent.pointerEnter(screen.getByRole('button', { name: '备份存在哪里' }), {
      pointerType: 'mouse',
    });
    await screen.findByText(PATH);
    shown();
    cleanup();

    stubApi({
      'GET /api/me': signedIn(),
      'GET /api/backup': () =>
        Response.json({
          backup: {
            ...google('connected', { email: 'ray@example.com' }).backup,
            progress: {
              waitingDays: 0,
              failing: [],
              backedUpTo: null,
              folderUrl: 'https://drive.google.com/drive/folders/f-root',
              categories: [],
              failingItems: [],
            },
          },
        }),
    });
    renderAt('/backup', routesWith(vi.fn()));
    expect(await screen.findByText('已连接 ray@example.com')).toBeDefined();
    expect(screen.queryByText(PATH)).toBeNull();
    act(() => screen.getByRole('button', { name: '备份存在哪里' }).focus());
    await screen.findByText(PATH);
    shown();
    expect(
      screen.getByRole('link', { name: '在 Google Drive 打开文件夹' }).getAttribute('href'),
    ).toBe('https://drive.google.com/drive/folders/f-root');
  });

  it('shows the account, the Testing expiry and disconnects keeping Drive files', async () => {
    stubApi({
      'GET /api/me': signedIn(),
      'GET /api/backup': () =>
        Response.json(
          google('connected', {
            email: 'ray@example.com',
            connectedAt: '2026-10-28T08:00:00.000Z',
            expiresAt: '2026-11-04T08:00:00.000Z',
          }),
        ),
      'POST /api/backup/google/disconnect': () => Response.json(google('disconnecting')),
    });
    renderAt('/backup', routesWith(vi.fn()));
    expect(await screen.findByText('已连接 ray@example.com')).toBeDefined();
    expect(screen.getByText(/Google 授权将在 .* 过期/)).toBeDefined();
    expect(screen.getByText('断开后停止备份，Drive 里已有的文件都会保留。')).toBeDefined();
    fireEvent.click(screen.getByText('断开连接'));
    expect(await screen.findByText('正在断开 Google Drive…')).toBeDefined();
  });

  it('says when telling Google to revoke the grant keeps failing', async () => {
    stubApi({
      'GET /api/me': signedIn(),
      'GET /api/backup': () => Response.json(google('disconnecting', { retrying: true })),
    });
    renderAt('/backup', routesWith(vi.fn()));
    expect((await screen.findByRole('alert')).textContent).toBe(
      '正在断开：暂时没能通知 Google 收回授权，正在重试',
    );
  });

  it('asks to reconnect and lists the problems', async () => {
    stubApi({
      'GET /api/me': signedIn(),
      'GET /api/backup': () =>
        Response.json({
          backup: {
            google: {
              state: 'reconnect',
              email: 'ray@example.com',
              connectedAt: null,
              expiresAt: null,
              retrying: false,
            },
            progress: null,
            attention: 'reconnect',
            events: [
              {
                at: '2026-10-28T08:00:00.000Z',
                kind: 'revoke_failed',
                diaryDate: null,
                item: null,
                email: null,
              },
            ],
          },
        }),
    });
    renderAt('/backup', routesWith(vi.fn()));
    expect((await screen.findAllByRole('alert'))[0]!.textContent).toBe(
      '需要重新连接 Google（ray@example.com）',
    );
    expect(screen.getByText(/第三方访问/)).toBeDefined();
  });
});

/** One line of the per-kind progress, matched whole ("日记：还有 3 天等待备份"). */
const progressLine = (text: string | RegExp) =>
  screen.findByText((_, el) =>
    el?.tagName === 'LI' && typeof text === 'string'
      ? el.textContent === text
      : el?.tagName === 'LI' && (text as RegExp).test(el.textContent ?? ''),
  );

describe('backup progress', () => {
  const connected = (
    progress: { waitingDays?: number; backedUpTo?: string } & Record<string, unknown>,
    attention: string | null = null,
  ) => ({
    backup: {
      ...google('connected', { email: 'ray@example.com' }).backup,
      progress: {
        waitingDays: 0,
        failing: [],
        backedUpTo: null,
        folderUrl: 'https://drive.google.com/drive/folders/f-1',
        categories: [
          {
            category: 'diaries',
            waiting: progress.waitingDays ?? 0,
            backedUpTo: progress.backedUpTo ?? null,
          },
          ...['shared_pages', 'wishes', 'gifts', 'anniversaries'].map((category) => ({
            category,
            waiting: 0,
            backedUpTo: null,
          })),
        ],
        failingItems: [],
        ...progress,
      },
      attention,
    },
  });

  it('[adr:server-backup-and-google-docs#7] says how many days wait, which failed and why, and backs up now', async () => {
    const run = vi.fn(() => Response.json(connected({ backedUpTo: '2026-10-28T01:22:00.000Z' })));
    stubApi({
      'GET /api/me': signedIn(),
      'GET /api/backup': () =>
        Response.json(
          connected({
            waitingDays: 3,
            failing: [
              { diaryDate: '2026-10-28', failure: 'unreachable' },
              { diaryDate: '2026-10-27', failure: 'unreachable' },
              { diaryDate: '2026-10-20', failure: 'failed' },
            ],
          }),
        ),
      'POST /api/backup/run': run,
    });
    renderAt('/backup', routesWith(vi.fn()));
    expect(await progressLine('日记：还有 3 天等待备份')).toBeDefined();
    expect(
      screen.getByText('暂时连不上 Google，2 天正在自动重试：10 月 28 日、10 月 27 日'),
    ).toBeDefined();
    expect(screen.getByText('有 1 天备份失败，正在自动重试：10 月 20 日')).toBeDefined();
    expect(
      screen.getByRole('link', { name: '在 Google Drive 打开文件夹' }).getAttribute('href'),
    ).toBe('https://drive.google.com/drive/folders/f-1');
    fireEvent.click(screen.getByText('现在备份'));
    expect(await progressLine(/^日记：已备份到 /)).toBeDefined();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('puts a banner on the home page only when the user has to act', async () => {
    let answer = connected({}, 'reconnect');
    stubApi({ 'GET /api/me': signedIn(), 'GET /api/backup': () => Response.json(answer) });
    const home = [{ path: '/', element: <BackupBanner /> }];
    renderAt('/', home);
    expect((await screen.findByRole('alert')).textContent).toMatch(/需要重新连接/);
    cleanup();

    answer = connected({}, 'failing');
    renderAt('/', home);
    expect((await screen.findByRole('alert')).textContent).toMatch(/一天多没有成功/);
    cleanup();

    // A failure younger than a day is for the backup page and the day page only.
    answer = connected({ waitingDays: 3 });
    renderAt('/', [
      {
        path: '/',
        element: (
          <>
            <BackupBanner />
            <BackupPage />
          </>
        ),
      },
    ]);
    expect(await progressLine('日记：还有 3 天等待备份')).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('[adr:google-copy-beyond-diaries#9] lists each kind, names failing pages and summaries, and says the copies go to both Drives', async () => {
    const page = '0d0d0d0d-0000-4000-8000-000000000009';
    const answer = connected({
      categories: [
        { category: 'diaries', waiting: 0, backedUpTo: '2026-11-18T01:22:00.000Z' },
        { category: 'shared_pages', waiting: 2, backedUpTo: null },
        { category: 'wishes', waiting: 0, backedUpTo: '2026-11-18T01:30:00.000Z' },
        { category: 'gifts', waiting: 1, backedUpTo: null },
        { category: 'anniversaries', waiting: 0, backedUpTo: null },
      ],
      failingItems: [
        { item: { kind: 'page', pageId: page, title: '旅行清单' }, failure: 'unreachable' },
        { item: { kind: 'gifts', pageId: null, title: null }, failure: 'failed' },
      ],
    });
    answer.backup.events = [
      {
        at: '2026-11-18T02:00:00.000Z',
        kind: 'doc_replaced',
        diaryDate: null,
        item: { kind: 'page', pageId: page, title: '' },
        email: null,
      },
      {
        at: '2026-11-18T01:00:00.000Z',
        kind: 'doc_recreated',
        diaryDate: null,
        item: { kind: 'wishes', pageId: null, title: null },
        email: null,
      },
      {
        at: '2026-11-17T01:00:00.000Z',
        kind: 'account_in_use',
        diaryDate: null,
        item: null,
        email: 'shared@example.com',
      },
    ] as never;
    stubApi({ 'GET /api/me': signedIn(), 'GET /api/backup': () => Response.json(answer) });
    renderAt('/backup', routesWith(vi.fn()));
    expect(await progressLine(/^日记：已备份到 /)).toBeDefined();
    expect(await progressLine('共享页面：还有 2 项等待备份')).toBeDefined();
    expect(await progressLine(/^心愿单：已备份到 /)).toBeDefined();
    expect(await progressLine('礼物墙：还有 1 项等待备份')).toBeDefined();
    expect(await progressLine('纪念日：还没有需要备份的内容')).toBeDefined();
    expect(screen.getByText('暂时连不上 Google，正在自动重试：共享页面「旅行清单」')).toBeDefined();
    expect(screen.getByText('备份失败，正在自动重试：礼物墙')).toBeDefined();
    expect(
      screen.getByText(/共享页面「未命名页面」的 Doc 在 Google 里被改过，已另存一份新的/),
    ).toBeDefined();
    expect(screen.getByText(/心愿单的 Doc 不见了，已重新生成/)).toBeDefined();
    expect(screen.getByText(/之前写进 shared@example\.com 的副本仍在那个 Drive 里/)).toBeDefined();
    expect(
      screen.getByText(/共享页面、心愿、礼物墙与纪念日会进你们两人各自的 Drive/).textContent,
    ).toContain('在应用里删除，不会从对方 Drive 的版本历史里消失');
  });
});

describe('GoogleCallbackPage', () => {
  it('[adr:server-backup-and-google-docs#13] hands code and state to the API and returns to the backup page', async () => {
    const finish = vi.fn((init: RequestInit | undefined) => {
      void init;
      return Response.json(google('connected', { email: 'ray@example.com' }));
    });
    stubApi({
      'GET /api/me': signedIn(),
      'POST /api/backup/google/finish': finish,
      'GET /api/backup': () => Response.json(google('connected', { email: 'ray@example.com' })),
    });
    const { router } = renderAt('/backup/google/callback?code=c-1&state=s-1', routesWith(vi.fn()));
    await waitFor(() => expect(router.state.location.pathname).toBe('/backup'));
    expect(JSON.parse(String(finish.mock.calls[0]![0]!.body))).toEqual({
      code: 'c-1',
      state: 's-1',
    });
    expect(router.state.location.search).toBe('');
    expect(await screen.findByText('已连接 ray@example.com')).toBeDefined();
  });

  it('explains a refused consent without calling the API', async () => {
    stubApi({ 'GET /api/me': signedIn() });
    renderAt('/backup/google/callback?error=access_denied', routesWith(vi.fn()));
    expect((await screen.findByRole('alert')).textContent).toBe(
      '你没有同意 Drive 授权，Google 备份未开启',
    );
  });

  it('explains an expired or foreign state', async () => {
    stubApi({
      'GET /api/me': signedIn(),
      'POST /api/backup/google/finish': () =>
        Response.json({ error: { code: 'GOOGLE_STATE_INVALID', message: 'x' } }, { status: 400 }),
    });
    renderAt('/backup/google/callback?code=c&state=s', routesWith(vi.fn()));
    expect((await screen.findByRole('alert')).textContent).toMatch(/已过期或不是从这里发起的/);
  });

  it('[adr:google-copy-beyond-diaries#12] asks for another account when this one is connected by someone else, naming no one', async () => {
    stubApi({
      'GET /api/me': signedIn(),
      'POST /api/backup/google/finish': () =>
        Response.json({ error: { code: 'GOOGLE_ACCOUNT_IN_USE', message: 'x' } }, { status: 409 }),
    });
    renderAt('/backup/google/callback?code=c&state=s', routesWith(vi.fn()));
    expect((await screen.findByRole('alert')).textContent).toBe(
      '这个 Google 账号已被另一位用户连接，请换一个账号',
    );
  });
});
