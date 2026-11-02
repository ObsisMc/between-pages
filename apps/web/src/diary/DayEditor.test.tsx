import 'fake-indexeddb/auto';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BODY, createDiaryDoc } from '@between-pages/collab';
import type { Day } from '@between-pages/contracts';
import * as Y from 'yjs';
import { DIARY, FakeSocket, GENERATION, USER, stubLocks } from '../../test/diary.ts';
import { renderAt, signedIn, stubApi } from '../../test/render.tsx';

const DATE = '2026-10-27';
const THEIRS = '8d2e3c9f-4a5b-4c6d-9e7f-0a1b2c3d4e5f';
const EPOCH = 'e1e1e1e1-0000-4000-8000-000000000001';
const PARTNER = '6f1c1d0e-0000-4000-8000-000000000002';
const SPACE = '2b0c1a9e-1111-4a2b-8c3d-4e5f6a7b8c9d';

afterEach(async () => {
  cleanup();
  FakeSocket.reset();
  vi.unstubAllGlobals();
  localStorage.clear();
  await new Promise((resolve) => {
    indexedDB.deleteDatabase(`between-pages-journal:${USER}`).onsuccess = resolve;
  });
});

const encoded = (text: string, clientID: number) => {
  const doc = createDiaryDoc();
  doc.clientID = clientID;
  if (text) doc.getText(BODY).insert(0, text);
  return Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64');
};

/** Alice's own diary of the day with `text`, written under clientID 11. */
const ownDiary = (text: string) => () =>
  Response.json({
    diary: {
      diaryId: DIARY,
      diaryDate: DATE,
      ownerId: USER,
      generationId: GENERATION,
      seq: 0,
      state: encoded(text, 11),
      bindings: text ? [{ clientId: 11, userId: USER }] : [],
    },
  });

/** Bob's diary of the day, shared live with Alice, written under clientID 77. */
const theirDiary = (text: string) => () =>
  Response.json({
    diary: {
      diaryId: THEIRS,
      diaryDate: DATE,
      ownerId: PARTNER,
      epochId: EPOCH,
      share: 'live',
      generationId: GENERATION,
      seq: 0,
      state: encoded(text, 77),
      bindings: [{ clientId: 77, userId: PARTNER }],
    },
  });

const card = (excerpt: string) => ({
  excerpt,
  updatedAt: '2026-10-27T08:00:00Z',
  hasText: excerpt !== '',
  unread: false,
  writing: false,
});
const dayOf = (mine: string | null, theirs: string | null, shared = true): Day => ({
  diaryDate: DATE,
  mine: mine === null ? null : { diaryId: DIARY, sharedWithPartner: shared, ...card(mine) },
  partner:
    theirs === null ? null : { diaryId: THEIRS, epochId: EPOCH, share: 'live', ...card(theirs) },
});

const spaces = () =>
  Response.json({
    spaces: [
      {
        id: SPACE,
        createdAt: '2026-10-01T08:00:00.000Z',
        state: 'active',
        participants: [
          { user: { id: USER, displayName: 'alice' }, authorSlot: 1 },
          { user: { id: PARTNER, displayName: 'bob' }, authorSlot: 2 },
        ],
      },
    ],
  });

const NO_COPY = { connected: false, docUrl: null, mine: null, partner: null, problem: null };
/** The workspace's feed beside the day, kept empty here: these tests are about the left page. */
const EMPTY_FEED = {
  'GET /api/days?before=2026-10-28': () =>
    Response.json({ days: [], nextBefore: null, nextAfter: null }),
  'GET /api/days?after=2026-10-27': () =>
    Response.json({ days: [], nextBefore: null, nextAfter: null }),
};

function openDay(day: Day, more: Parameters<typeof stubApi>[0] = {}) {
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('navigator', { locks: stubLocks() });
  const api = stubApi({
    'GET /api/me': signedIn('alice'),
    'GET /api/spaces': spaces,
    [`GET /api/days/${DATE}`]: () => Response.json({ day, google: NO_COPY }),
    [`GET /api/diaries/${DIARY}`]: ownDiary(day.mine?.excerpt ?? ''),
    [`GET /api/diaries/${THEIRS}/shares/${EPOCH}`]: theirDiary(day.partner?.excerpt ?? ''),
    [`GET /api/diaries/${DIARY}/read`]: () => Response.json({ ranges: [] }),
    [`GET /api/diaries/${THEIRS}/read`]: () => Response.json({ ranges: [] }),
    ...EMPTY_FEED,
    ...more,
  });
  const rendered = renderAt(`/days/${DATE}`);
  return { api, ...rendered };
}

const section = (name: '我的日记' | 'TA 的日记') => screen.findByRole('region', { name });
const editorOf = async (name: '我的日记' | 'TA 的日记') =>
  within(await section(name)).findByRole('textbox');

async function paste(editor: HTMLElement, content: string) {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: { getData: (type: string) => (type === 'text/plain' ? content : '') },
  });
  editor.dispatchEvent(event);
}

describe('DayEditor', () => {
  it('[adr:unread-and-day-page#9] stacks both diaries as two sessions, so a paste reaches only the one it was made in', async () => {
    openDay(dayOf('我的早上', '他的晚上'));
    const mine = await editorOf('我的日记');
    const theirs = await editorOf('TA 的日记');
    await waitFor(() => expect(theirs.textContent).toBe('他的晚上'));
    await waitFor(() => expect(mine.textContent).toBe('我的早上'));
    // Slot order: alice (1) above bob (2).
    const regions = screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'));
    expect(regions.filter((n) => n?.endsWith('的日记'))).toEqual(['我的日记', 'TA 的日记']);
    expect(within(await section('TA 的日记')).getByRole('img', { name: 'bob' })).toBeTruthy();

    await paste(mine, '，下雨');
    await waitFor(() => expect(mine.textContent).toBe('我的早上，下雨'));
    expect(theirs.textContent).toBe('他的晚上');
    const submits = () =>
      FakeSocket.all.flatMap((socket) =>
        socket.sent.flatMap((m) => (m.type === 'submit' ? [m.diaryId] : [])),
      );
    await waitFor(() => expect(submits()).toEqual([DIARY]));
    const subscribed = FakeSocket.all.flatMap((socket) =>
      socket.sent.flatMap((m) => (m.type === 'subscribe' ? [m.diaryId] : [])),
    );
    expect(subscribed.sort()).toEqual([DIARY, THEIRS].sort());
  });

  it('[adr:server-backup-and-google-docs#7] [adr:book-frontend-workspace#8] shows how far the own Drive holds each diary, beside its save status', async () => {
    const day = dayOf('我的', '他的');
    openDay(day, {
      [`GET /api/days/${DATE}`]: () =>
        Response.json({
          day,
          google: {
            connected: true,
            docUrl: 'https://docs.google.com/document/d/doc-1/edit',
            mine: '2026-10-20T01:22:00.000Z',
            partner: null,
            problem: null,
          },
        }),
    });
    const mine = await section('我的日记');
    expect(await within(mine).findByText(/^已备份到 Google/)).toBeDefined();
    expect(
      within(mine).getByRole('link', { name: '在 Google Docs 打开' }).getAttribute('href'),
    ).toBe('https://docs.google.com/document/d/doc-1/edit');
    expect(await within(await section('TA 的日记')).findByText('等待备份到 Google')).toBeDefined();
  });

  it('says on both diaries why newer text is not in Google yet, keeping how far it is', async () => {
    const day = dayOf('我的', '他的');
    openDay(day, {
      [`GET /api/days/${DATE}`]: () =>
        Response.json({
          day,
          google: {
            connected: true,
            docUrl: 'https://docs.google.com/document/d/doc-1/edit',
            mine: '2026-10-20T01:22:00.000Z',
            partner: null,
            problem: 'unreachable',
          },
        }),
    });
    expect(
      await within(await section('我的日记')).findByText(
        /^暂时连不上 Google，正在自动重试 · 已备份到 Google/,
      ),
    ).toBeDefined();
    expect(
      await within(await section('TA 的日记')).findByText('暂时连不上 Google，正在自动重试'),
    ).toBeDefined();
  });

  it('says when the Google copy is off', async () => {
    openDay(dayOf('我的', null));
    expect(await within(await section('我的日记')).findByText('未开启 Google 备份')).toBeDefined();
  });

  it('swaps the order on this device only, and falls back to the slot order without storage', async () => {
    openDay(dayOf('我的', '他的'));
    fireEvent.click(await screen.findByRole('button', { name: '交换顺序' }));
    const order = () =>
      screen
        .getAllByRole('region')
        .map((r) => r.getAttribute('aria-label'))
        .filter((n) => n?.endsWith('的日记'));
    await waitFor(() => expect(order()).toEqual(['TA 的日记', '我的日记']));
    expect(localStorage.getItem('between-pages:day-order')).toBe('swapped');
    cleanup();

    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    openDay(dayOf('我的', '他的'));
    await screen.findByRole('button', { name: '交换顺序' });
    expect(order()).toEqual(['我的日记', 'TA 的日记']);
    vi.restoreAllMocks();
  });

  it('[adr:unread-and-day-page#11] says the own diary is only visible to its writer when it is not shared now', async () => {
    openDay(dayOf('我的', '他的', false));
    const mine = await section('我的日记');
    expect(await within(mine).findByText('仅自己可见')).toBeDefined();
    expect(within(await section('TA 的日记')).queryByText('仅自己可见')).toBeNull();
  });

  it('switches between both, mine and theirs, keeping the hidden diary mounted', async () => {
    openDay(dayOf('我的', '他的'));
    const theirs = await editorOf('TA 的日记');
    await waitFor(() => expect(theirs.textContent).toBe('他的'));
    const views = await screen.findByRole('group', { name: '视图' });
    expect(within(views).getByRole('button', { name: '双人' }).getAttribute('aria-pressed')).toBe(
      'true',
    );

    fireEvent.click(within(views).getByRole('button', { name: '我的' }));
    const hidden = theirs.closest('section')!;
    await waitFor(() => expect(hidden.hidden).toBe(true));
    expect(theirs.isConnected).toBe(true);
    fireEvent.click(within(views).getByRole('button', { name: 'TA 的' }));
    await waitFor(() => expect(hidden.hidden).toBe(false));
    // A hidden section has no accessible name, so it is found by its label.
    const mine = document.querySelector<HTMLElement>('section[aria-label="我的日记"]')!;
    expect(mine.hidden).toBe(true);
    expect(within(mine).getByRole('textbox', { hidden: true }).isConnected).toBe(true);
  });

  it('offers no view switch while one side has no text', async () => {
    openDay(dayOf('', '他的'));
    await waitFor(async () => expect((await editorOf('TA 的日记')).textContent).toBe('他的'));
    expect(screen.queryByRole('group', { name: '视图' })).toBeNull();
  });

  it('starts the own diary of the day in place with "写这天"', async () => {
    const created = vi.fn(() =>
      Response.json({
        created: true,
        diary: {
          diaryId: DIARY,
          diaryDate: DATE,
          ownerId: USER,
          generationId: GENERATION,
          seq: 0,
          state: encoded('', 11),
          bindings: [],
        },
      }),
    );
    const { router } = openDay(dayOf(null, '他的'), { 'POST /api/diaries': created });
    fireEvent.click(await screen.findByRole('button', { name: '写这天' }));
    expect(await editorOf('我的日记')).toBeDefined();
    expect(router.state.location.pathname).toBe(`/days/${DATE}`);
    const [init] = created.mock.calls[0] as unknown as [RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({ date: DATE });
  });

  it('says the day has not begun here when the server refuses a future date', async () => {
    openDay(dayOf(null, '他的'), {
      'POST /api/diaries': () =>
        Response.json({ error: { code: 'VALIDATION_FAILED', message: 'future' } }, { status: 400 }),
    });
    fireEvent.click(await screen.findByRole('button', { name: '写这天' }));
    expect(await screen.findByText('你这边还没到这一天')).toBeDefined();
    expect(screen.queryByRole('button', { name: '写这天' })).toBeNull();
  });
});

describe('the own diary page', () => {
  it('[adr:unread-and-day-page#13] offers the day page once the partner shares the day, without changing the page', async () => {
    let shared = false;
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal('navigator', { locks: stubLocks() });
    stubApi({
      'GET /api/me': signedIn('alice'),
      'GET /api/spaces': spaces,
      [`GET /api/diaries/${DIARY}`]: ownDiary('我的'),
      [`GET /api/diaries/${DIARY}/read`]: () => Response.json({ ranges: [] }),
      [`GET /api/days/${DATE}`]: () =>
        Response.json({ day: dayOf('我的', shared ? '他的' : null), google: NO_COPY }),
    });
    const { router } = renderAt(`/diaries/${DIARY}`);
    const editor = await screen.findByRole('textbox');
    await waitFor(() => expect(editor.textContent).toBe('我的'));
    expect(screen.queryByText(/TA 也写了这天/)).toBeNull();

    shared = true;
    fireEvent(window, new Event('focus'));
    const offer = await screen.findByText(/TA 也写了这天/);
    expect(within(offer).getByRole('link', { name: '切到双人页' }).getAttribute('href')).toBe(
      `/days/${DATE}`,
    );
    expect(router.state.location.pathname).toBe(`/diaries/${DIARY}`);
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
  });
});
