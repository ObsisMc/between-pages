import 'fake-indexeddb/auto';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BODY, createDiaryDoc } from '@between-pages/collab';
import { PROTOCOL_VERSION, type Day } from '@between-pages/contracts';
import * as Y from 'yjs';
import { DIARY, FakeSocket, GENERATION, USER, diaryResponse, stubLocks } from '../../test/diary.ts';
import { DWELL_MS } from '../read-tracker/index.ts';
import { renderAt, signedIn, stubApi } from '../../test/render.tsx';

// One diary's session inside the diary page's 「这一天」, where every diary opens since the
// single-diary page was dropped (drop-single-diary-page): the save line, drafts, refusals,
// history, a partner's share, author colors, the own-text filter and unread.

const clipboard = { writeText: vi.fn<(text: string) => Promise<void>>(async () => undefined) };
const DATE = '2026-10-27';
const EPOCH = 'e1e1e1e1-0000-4000-8000-000000000001';
const PARTNER = '6f1c1d0e-0000-4000-8000-000000000002';
const NO_COPY = { connected: false, docUrl: null, mine: null, partner: null, problem: null };
const card = {
  excerpt: '',
  updatedAt: '2026-10-27T08:00:00Z',
  hasText: true,
  unread: false,
  writing: false,
};
const spaces = () =>
  Response.json({
    spaces: [
      {
        id: '2b0c1a9e-1111-4a2b-8c3d-4e5f6a7b8c9d',
        createdAt: '2026-10-01T08:00:00.000Z',
        state: 'active',
        participants: [
          { user: { id: USER, displayName: 'alice' }, authorSlot: 1 },
          { user: { id: PARTNER, displayName: 'bob' }, authorSlot: 2 },
        ],
      },
    ],
  });
/** The feed beside the day, empty: these tests are about the day's diary. */
const EMPTY_FEED = {
  'GET /api/days?before=2026-10-28': () =>
    Response.json({ days: [], nextBefore: null, nextAfter: null }),
  'GET /api/days?after=2026-10-27': () =>
    Response.json({ days: [], nextBefore: null, nextAfter: null }),
};

/** Opens 「这一天」 of `day` at `/days/:date`, with the given answers on top. */
function openDay(day: Day, more: Parameters<typeof stubApi>[0]) {
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('navigator', { locks: stubLocks(), clipboard });
  const api = stubApi({
    'GET /api/me': signedIn('alice'),
    'GET /api/spaces': spaces,
    [`GET /api/days/${DATE}`]: () => Response.json({ day, google: NO_COPY }),
    [`GET /api/diaries/${DIARY}/read`]: () => Response.json({ ranges: [] }),
    ...EMPTY_FEED,
    ...more,
  });
  return { api, ...renderAt(`/days/${DATE}`) };
}

afterEach(async () => {
  cleanup();
  FakeSocket.reset();
  clipboard.writeText.mockClear();
  vi.unstubAllGlobals();
  // Each test starts with an empty journal for the one signed-in user.
  await new Promise((resolve) => {
    indexedDB.deleteDatabase(`between-pages-journal:${USER}`).onsuccess = resolve;
  });
});

/** The caller's own diary of the day, alone on it. */
function openDiary(
  diary: () => Response = diaryResponse,
  more: Record<string, (init?: RequestInit) => Response> = {},
) {
  return openDay(
    { diaryDate: DATE, mine: { diaryId: DIARY, sharedWithPartner: false, ...card }, partner: null },
    { [`GET /api/diaries/${DIARY}`]: diary, ...more },
  );
}

async function paste(content: string) {
  const editor = await screen.findByRole('textbox');
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: { getData: (type: string) => (type === 'text/plain' ? content : '') },
  });
  editor.dispatchEvent(event);
}

/** The diary's save line: the status that says where the text is. */
const status = () =>
  screen.findByText(
    /^(已保存到服务器|正在同步|已同步 · 对方可以看到|正在保存到本机|正在确认保存结果|暂时无法同步，已保存在本机)$/,
  );

describe('the single-diary page', () => {
  it('[adr:drop-single-diary-page#1] is gone: its addresses go home and open no diary', async () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    const api = stubApi({ 'GET /api/me': signedIn('alice') });
    const { router } = renderAt(`/diaries/${DIARY}/shares/${EPOCH}`);
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(
      api.mock.calls.map(([url]) => String(url)).filter((url) => url.includes('/api/diaries')),
    ).toEqual([]);
    expect(FakeSocket.all).toHaveLength(0);
  });
});

describe('a diary in 这一天', () => {
  it('[adr:drop-single-diary-page#2] says saved to the server only once the batch is acknowledged', async () => {
    openDiary();
    await waitFor(async () => expect((await status()).textContent).toBe('已保存到服务器'));
    FakeSocket.answer = () => 'hold';
    await paste('今天下雨');
    await waitFor(async () => expect((await status()).textContent).toBe('正在同步'));
    FakeSocket.release();
    await waitFor(async () => expect((await status()).textContent).toBe('已保存到服务器'));
  });

  it('says the partner can read what is saved while the own diary is shared, until it stops', async () => {
    FakeSocket.shared = true;
    openDiary();
    await waitFor(async () => expect((await status()).textContent).toBe('已同步 · 对方可以看到'));
    FakeSocket.all[0]!.push({
      v: PROTOCOL_VERSION,
      type: 'context',
      diaryId: DIARY,
      change: 'stopped',
      generationId: GENERATION,
      epochId: 'e1e1e1e1-0000-4000-8000-000000000001',
    });
    await waitFor(async () => expect((await status()).textContent).toBe('已保存到服务器'));
  });

  it('lists refused input as a draft to copy and, after confirming, delete', async () => {
    openDiary();
    await waitFor(async () => expect((await status()).textContent).toBe('已保存到服务器'));
    FakeSocket.answer = () => 'EDIT_REJECTED';
    await paste('被拒的');

    const drafts = await screen.findByRole('region', { name: '恢复草稿' });
    expect(drafts.textContent).toContain('服务器没有接受这段输入');
    expect(drafts.textContent).toContain('被拒的');
    fireEvent.click(screen.getByText('复制新写的文字'));
    expect(clipboard.writeText).toHaveBeenCalledWith('被拒的');
    expect(await screen.findByText('已复制')).toBeDefined();

    fireEvent.click(screen.getByText('删除草稿'));
    expect(screen.queryByRole('region', { name: '恢复草稿' })).not.toBeNull();
    fireEvent.click(screen.getByText('确认删除这条草稿'));
    await waitFor(() => expect(screen.queryByRole('region', { name: '恢复草稿' })).toBeNull());
  });

  it('tells why a paste was refused', async () => {
    openDiary();
    await waitFor(async () => expect((await status()).textContent).toBe('已保存到服务器'));
    await paste('字'.repeat(300_000));
    expect((await screen.findByRole('alert')).textContent).toBe(
      '粘贴内容超过约 26 万字，请分段粘贴',
    );
  });

  it('[adr:diary-collaboration-kernel#4] previews history read-only and returns to the untouched current text', async () => {
    const version = '00000000-0000-4000-8000-000000000001';
    openDiary(diaryResponse, {
      [`GET /api/diaries/${DIARY}/history`]: () =>
        Response.json({
          points: [{ publicId: version, committedAt: '2026-10-27T08:00:00Z', authors: [USER] }],
          nextCursor: null,
          nextPointInMs: null,
        }),
      [`GET /api/diaries/${DIARY}/history/${version}`]: () =>
        Response.json({
          publicId: version,
          committedAt: '2026-10-27T08:00:00Z',
          runs: [{ author: USER, text: '早上的版本' }],
        }),
    });
    await waitFor(async () => expect((await status()).textContent).toBe('已保存到服务器'));
    await paste('现在的字');
    await waitFor(async () => expect((await status()).textContent).toBe('已保存到服务器'));

    fireEvent.click(screen.getByRole('button', { name: '历史' }));
    const panel = await screen.findByRole('complementary', { name: '历史版本' });
    fireEvent.click(await within(panel).findByRole('button', { pressed: false }));
    expect(await screen.findByText('早上的版本')).toBeDefined();
    expect(screen.queryByRole('textbox')).toBeNull(); // hidden, still mounted

    // Another device commits while the preview is open: it stays, and says so.
    const other = createDiaryDoc();
    other.getText(BODY).insert(0, '远端');
    FakeSocket.all[0]!.push({
      v: PROTOCOL_VERSION,
      type: 'commit',
      diaryId: DIARY,
      generationId: GENERATION,
      seq: ++FakeSocket.seq,
      publicId: crypto.randomUUID(),
      delta: btoa(String.fromCharCode(...Y.encodeStateAsUpdate(other))),
      bindings: [{ clientId: other.clientID, userId: USER }],
    });
    expect(await screen.findByText('当前正文有更新')).toBeDefined();
    expect(screen.getByText('早上的版本')).toBeDefined();
    expect(screen.queryByRole('button', { name: /恢复|回滚/ })).toBeNull();

    fireEvent.click(screen.getByText('返回当前正文'));
    const editor = await screen.findByRole('textbox');
    expect(editor.textContent).toContain('现在的字');
    expect(editor.textContent).toContain('远端');
  });
});

describe('a shared diary', () => {
  const BOB_CLIENT = 77;

  /** The partner Bob's diary as Alice may read it, in the given share state. */
  function sharedResponse(share: 'live' | 'frozen') {
    const doc = createDiaryDoc();
    doc.clientID = BOB_CLIENT;
    doc.getText(BODY).insert(0, '鲍勃的字');
    return () =>
      Response.json({
        diary: {
          diaryId: DIARY,
          diaryDate: '2026-10-27',
          ownerId: PARTNER,
          epochId: EPOCH,
          share,
          generationId: GENERATION,
          seq: 0,
          state: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64'),
          bindings: [{ clientId: BOB_CLIENT, userId: PARTNER }],
        },
      });
  }

  /** Bob's diary of the day, shared with Alice, alone on it (she has none). */
  function openShared(share: 'live' | 'frozen', more: Parameters<typeof stubApi>[0] = {}) {
    return openDay(
      {
        diaryDate: DATE,
        mine: null,
        partner: { diaryId: DIARY, epochId: EPOCH, share, ...card },
      },
      { [`GET /api/diaries/${DIARY}/shares/${EPOCH}`]: sharedResponse(share), ...more },
    );
  }

  it('[adr:drop-single-diary-page#3] opens a share reopened while shown in place, as a new session of the new epoch', async () => {
    const REOPENED = 'e1e1e1e1-0000-4000-8000-000000000002';
    let epoch = EPOCH;
    const days = vi.fn(() =>
      Response.json({
        day: {
          diaryDate: DATE,
          mine: null,
          partner: { diaryId: DIARY, epochId: epoch, share: 'live', ...card },
        },
        google: NO_COPY,
      }),
    );
    const { router } = openShared('live', {
      [`GET /api/days/${DATE}`]: days,
      [`GET /api/diaries/${DIARY}/shares/${REOPENED}`]: sharedResponse('live'),
    });
    const editor = await screen.findByRole('textbox');
    await waitFor(() => expect(editor.textContent).toBe('鲍勃的字'));
    const first = FakeSocket.all.at(-1)!;
    first.push({
      v: PROTOCOL_VERSION,
      type: 'context',
      diaryId: DIARY,
      change: 'opened',
      generationId: GENERATION,
      epochId: REOPENED,
    });
    const open = await screen.findByRole('button', { name: '打开最新的版本' });
    expect(screen.queryByRole('link', { name: '打开最新的版本' })).toBeNull();
    const asked = days.mock.calls.length;
    epoch = REOPENED;
    fireEvent.click(open);
    await waitFor(() => expect(days.mock.calls.length).toBe(asked + 1));
    await waitFor(() =>
      expect(FakeSocket.all.at(-1)!.sent[0]).toMatchObject({
        type: 'subscribe',
        epochId: REOPENED,
      }),
    );
    expect(FakeSocket.all.at(-1)).not.toBe(first);
    expect(router.state.location.pathname).toBe(`/days/${DATE}`);
  });

  it('[adr:diary-collaboration-kernel#11] shows a frozen share read-only, says it no longer updates, and opens no socket', async () => {
    openShared('frozen');

    expect(await screen.findByText('已停止共享，内容不再更新')).toBeDefined();
    const editor = await screen.findByRole('textbox');
    await waitFor(() => expect(editor.textContent).toBe('鲍勃的字'));
    expect(editor.getAttribute('contenteditable')).toBe('false');
    expect(FakeSocket.all).toHaveLength(0);
  });

  it('says the owner can read what the partner saved in a live share', async () => {
    openShared('live');
    await waitFor(async () => expect((await status()).textContent).toBe('已同步 · 对方可以看到'));
  });

  it('colors the text by its author’s slot, names both in a legend, and filters to the own text', async () => {
    openShared('live');
    const editor = await screen.findByRole('textbox');
    await waitFor(() =>
      expect(editor.querySelector('.author-slot-2')?.textContent).toBe('鲍勃的字'),
    );
    const legend = screen.getByLabelText('作者');
    expect(within(legend).getByText('alice').classList.contains('author-slot-1')).toBe(true);
    expect(within(legend).getByText('bob').classList.contains('author-slot-2')).toBe(true);
    expect(FakeSocket.all.at(-1)?.sent[0]).toMatchObject({ type: 'subscribe', epochId: EPOCH });

    fireEvent.click(screen.getByLabelText('只看我的文字'));
    await waitFor(() =>
      expect(editor.querySelector('.author-hidden')?.textContent).toBe('鲍勃的字'),
    );
    expect(editor.getAttribute('contenteditable')).toBe('false');
  });

  it('[adr:diary-collaboration-kernel#26] counts nothing hidden by the own-text-only filter as read (EDIT-14)', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    // jsdom has no layout: the editor fills the window and no point maps to a position,
    // so the whole text counts as on screen; text measures as a zero box at the top.
    Object.defineProperty(document, 'elementFromPoint', { value: () => null, configurable: true });
    for (const [name, value] of [
      ['getClientRects', () => []],
      ['getBoundingClientRect', () => new DOMRect()],
    ] as const)
      Object.defineProperty(Range.prototype, name, { value, configurable: true });
    const reports: unknown[] = [];
    openShared('live', {
      [`POST /api/diaries/${DIARY}/read`]: (init) => {
        const body = JSON.parse(String(init!.body));
        reports.push(body.ranges);
        return Response.json(body);
      },
    });
    try {
      const editor = await screen.findByRole('textbox');
      await waitFor(() => expect(editor.textContent).toBe('鲍勃的字'));
      // The editor and, on a wide page, the day's own scrolling box both span the window.
      const window400 = { top: 0, bottom: 400, left: 0, right: 600 } as DOMRect;
      vi.spyOn(editor.parentElement!, 'getBoundingClientRect').mockReturnValue(window400);
      const box = document.querySelector<HTMLElement>('.day-scroll');
      if (box) vi.spyOn(box, 'getBoundingClientRect').mockReturnValue(window400);

      fireEvent.click(screen.getByLabelText('只看我的文字'));
      await waitFor(() => expect(editor.querySelector('.author-hidden')).not.toBeNull());
      await vi.advanceTimersByTimeAsync(3 * DWELL_MS);
      expect(reports).toEqual([]);

      fireEvent.click(screen.getByLabelText('只看我的文字'));
      await vi.advanceTimersByTimeAsync(2 * DWELL_MS);
      expect(reports).toEqual([[{ clientId: BOB_CLIENT, from: 0, to: 4 }]]);
    } finally {
      vi.useRealTimers();
      delete (document as { elementFromPoint?: unknown }).elementFromPoint;
      for (const name of ['getClientRects', 'getBoundingClientRect'])
        delete (Range.prototype as unknown as Record<string, unknown>)[name];
    }
  });
  describe('unread', () => {
    /** Alice has read "勃的" of Bob's "鲍勃的字": "鲍" and "字" are left, two passages. */
    const halfRead = () => Response.json({ ranges: [{ clientId: BOB_CLIENT, from: 1, to: 3 }] });

    it('[adr:unread-and-day-page#6] [adr:unread-and-day-page#14] offers the unread on opening without moving, jumps only when asked and sends nothing', async () => {
      const scrolled = vi.fn();
      vi.stubGlobal('scrollTo', scrolled);
      vi.stubGlobal('scrollBy', scrolled);
      openShared('live', { [`GET /api/diaries/${DIARY}/read`]: halfRead });

      expect((await screen.findByText(/有 2 处新内容/)).textContent).toBe(
        '有 2 处新内容 · 跳到第一处',
      );
      expect(screen.getByRole('button', { name: '下一处未读' })).toBeDefined();
      expect(scrolled).not.toHaveBeenCalled();
      const editor = screen.getByRole('textbox');
      expect(editor.querySelector('.unread-flash')).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: '跳到第一处' }));
      await waitFor(() => expect(editor.querySelector('.unread-flash')?.textContent).toBe('鲍'));
      expect(screen.queryByText(/有 2 处新内容/)).toBeNull();
      expect(screen.getByRole('button', { name: '下一处未读' })).toBeDefined();
      expect(editor.textContent).toBe('鲍勃的字');
      const sent = FakeSocket.all.flatMap((socket) => socket.sent).map((m) => m.type);
      expect(sent.filter((type) => type !== 'subscribe')).toEqual([]);
    });

    it('marks the unread characters in the editor once the coverage is known', async () => {
      openShared('live', { [`GET /api/diaries/${DIARY}/read`]: halfRead });
      const editor = await screen.findByRole('textbox');
      await waitFor(() =>
        expect(
          [...editor.querySelectorAll('.day-text-unread')].map((el) => el.textContent),
        ).toEqual(['鲍', '字']),
      );
      fireEvent.click(screen.getByLabelText('只看我的文字'));
      await waitFor(() => expect(editor.querySelector('.day-text-unread')).toBeNull());
    });

    it('[adr:unread-and-day-page#7] shows no unread while 只看我的文字 hides the other person’s text', async () => {
      openShared('live', { [`GET /api/diaries/${DIARY}/read`]: halfRead });
      await screen.findByRole('button', { name: '下一处未读' });

      fireEvent.click(screen.getByLabelText('只看我的文字'));
      await waitFor(() => expect(screen.queryByRole('button', { name: '下一处未读' })).toBeNull());
      expect(screen.queryByText(/处新内容/)).toBeNull();

      fireEvent.click(screen.getByLabelText('只看我的文字'));
      expect(await screen.findByRole('button', { name: '下一处未读' })).toBeDefined();
    });

    describe('text arriving while in view (read-marks-until-leaving D5)', () => {
      /** The editor's marked characters as `[class, text]`. */
      const marksIn = (editor: HTMLElement) =>
        [...editor.querySelectorAll('.day-text-unread, .day-text-kept')].map((el) => [
          el.className.includes('day-text-kept') ? 'kept' : 'unread',
          el.textContent,
        ]);

      /**
       * Bob's diary all read, laid out so the whole editor fills the window; Bob then
       * appends `text` and the server sends it as `how`, a broadcast or a catch-up.
       */
      async function bobAppends(text: string, how: 'commit' | 'synced') {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
        Object.defineProperty(document, 'elementFromPoint', {
          value: () => null,
          configurable: true,
        });
        for (const [name, value] of [
          ['getClientRects', () => []],
          ['getBoundingClientRect', () => new DOMRect()],
        ] as const)
          Object.defineProperty(Range.prototype, name, { value, configurable: true });
        let read = [{ clientId: BOB_CLIENT, from: 0, to: 4 }];
        const reports: unknown[] = [];
        openShared('live', {
          [`GET /api/diaries/${DIARY}/read`]: () => Response.json({ ranges: read }),
          [`POST /api/diaries/${DIARY}/read`]: (init) => {
            const { ranges } = JSON.parse(String(init!.body));
            reports.push(ranges);
            read = [...read, ...ranges];
            return Response.json({ ranges: read });
          },
        });
        const editor = await screen.findByRole('textbox');
        await waitFor(() => expect(editor.textContent).toBe('鲍勃的字'));
        const inView = { top: 0, bottom: 400, left: 0, right: 600 } as DOMRect;
        const place = vi.spyOn(editor.parentElement!, 'getBoundingClientRect');
        place.mockReturnValue(inView);
        const box = document.querySelector<HTMLElement>('.day-scroll');
        if (box) vi.spyOn(box, 'getBoundingClientRect').mockReturnValue(inView);
        // The coverage is known before Bob writes.
        await vi.advanceTimersByTimeAsync(DWELL_MS);

        const bob = createDiaryDoc();
        bob.clientID = BOB_CLIENT;
        bob.getText(BODY).insert(0, '鲍勃的字');
        const before = Y.encodeStateVector(bob);
        bob.getText(BODY).insert(4, text);
        const commit = {
          seq: ++FakeSocket.seq,
          publicId: crypto.randomUUID(),
          delta: btoa(String.fromCharCode(...Y.encodeStateAsUpdate(bob, before))),
        };
        const socket = FakeSocket.all.at(-1)!;
        const message = { v: PROTOCOL_VERSION, diaryId: DIARY, generationId: GENERATION };
        if (how === 'commit') socket.push({ ...message, type: 'commit', ...commit, bindings: [] });
        else
          socket.push({
            ...message,
            type: 'synced',
            seq: commit.seq,
            commits: [commit],
            bindings: [],
          });
        await waitFor(() => expect(editor.textContent).toBe(`鲍勃的字${text}`));
        return { editor, reports, place };
      }

      afterEach(() => {
        vi.useRealTimers();
        delete (document as { elementFromPoint?: unknown }).elementFromPoint;
        for (const name of ['getClientRects', 'getBoundingClientRect'])
          delete (Range.prototype as unknown as Record<string, unknown>)[name];
      });

      it('[adr:read-marks-until-leaving#6] [adr:read-marks-until-leaving#7] draws a broadcast in view light at once, still unread until it is reported read', async () => {
        const { editor, reports } = await bobAppends('新字', 'commit');
        expect(marksIn(editor)).toEqual([['kept', '新字']]);
        // Still unread: the next unread jump goes to it.
        expect(await screen.findByRole('button', { name: '下一处未读' })).toBeDefined();

        await vi.advanceTimersByTimeAsync(2 * DWELL_MS);
        expect(reports).toEqual([[{ clientId: BOB_CLIENT, from: 4, to: 6 }]]);
        await waitFor(() =>
          expect(screen.queryByRole('button', { name: '下一处未读' })).toBeNull(),
        );
        // Read now, and kept for the visit: it looks the same.
        expect(marksIn(editor)).toEqual([['kept', '新字']]);
      });

      it('[adr:read-marks-until-leaving#7] draws it solid again once it leaves view unread', async () => {
        const { editor, place } = await bobAppends('新字', 'commit');
        expect(marksIn(editor)).toEqual([['kept', '新字']]);
        // Scrolled away above the window before a second passed.
        place.mockReturnValue({ top: -800, bottom: -400, left: 0, right: 600 } as DOMRect);
        fireEvent.scroll(window);
        // Measured on the next frame, well before the tracker's next check.
        await vi.advanceTimersByTimeAsync(50);
        await waitFor(() => expect(marksIn(editor)).toEqual([['unread', '新字']]));
        expect(screen.getByRole('button', { name: '下一处未读' })).toBeDefined();
      });

      it('[adr:read-marks-until-leaving#6] draws a catch-up solid', async () => {
        const { editor } = await bobAppends('新字', 'synced');
        await waitFor(() => expect(marksIn(editor)).toEqual([['unread', '新字']]));
      });

      it('[adr:read-marks-until-leaving#6] draws a broadcast to a hidden page solid', async () => {
        vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
        const { editor } = await bobAppends('新字', 'commit');
        await waitFor(() => expect(marksIn(editor)).toEqual([['unread', '新字']]));
      });
    });

    it('[adr:unread-and-day-page#5] drops unread text the other person deletes, and counts what they type again', async () => {
      openShared('live', { [`GET /api/diaries/${DIARY}/read`]: halfRead });
      await screen.findByRole('button', { name: '下一处未读' });

      const bob = createDiaryDoc();
      const served = await (sharedResponse('live')().json() as Promise<{
        diary: { state: string };
      }>);
      Y.applyUpdate(
        bob,
        Uint8Array.from(atob(served.diary.state), (c) => c.charCodeAt(0)),
      );
      bob.clientID = BOB_CLIENT + 1;
      const commit = (update: Uint8Array) =>
        FakeSocket.all.at(-1)!.push({
          v: PROTOCOL_VERSION,
          type: 'commit',
          diaryId: DIARY,
          generationId: GENERATION,
          seq: ++FakeSocket.seq,
          publicId: crypto.randomUUID(),
          delta: btoa(String.fromCharCode(...update)),
          bindings: [{ clientId: BOB_CLIENT + 1, userId: PARTNER }],
        });
      const before = Y.encodeStateVector(bob);
      bob.transact(() => {
        bob.getText(BODY).delete(3, 1);
        bob.getText(BODY).delete(0, 1);
      });
      commit(Y.encodeStateAsUpdate(bob, before));
      const editor = screen.getByRole('textbox');
      await waitFor(() => expect(editor.textContent).toBe('勃的'));
      await waitFor(() => expect(screen.queryByRole('button', { name: '下一处未读' })).toBeNull());

      const typed = Y.encodeStateVector(bob);
      bob.getText(BODY).insert(0, '鲍');
      commit(Y.encodeStateAsUpdate(bob, typed));
      expect(await screen.findByRole('button', { name: '下一处未读' })).toBeDefined();
    });
  });
});
