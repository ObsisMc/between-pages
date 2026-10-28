import 'fake-indexeddb/auto';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BODY, createDiaryDoc } from '@between-pages/collab';
import { PROTOCOL_VERSION } from '@between-pages/contracts';
import * as Y from 'yjs';
import { DIARY, FakeSocket, GENERATION, USER, diaryResponse, stubLocks } from '../../test/diary.ts';
import { DWELL_MS } from '../read-tracker/index.ts';
import { renderAt, signedIn, stubApi } from '../../test/render.tsx';

const clipboard = { writeText: vi.fn<(text: string) => Promise<void>>(async () => undefined) };

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

function openDiary(
  diary: () => Response = diaryResponse,
  more: Record<string, () => Response> = {},
) {
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('navigator', { locks: stubLocks(), clipboard });
  stubApi({ 'GET /api/me': signedIn('alice'), [`GET /api/diaries/${DIARY}`]: diary, ...more });
  renderAt(`/diaries/${DIARY}`);
}

async function paste(content: string) {
  const editor = await screen.findByRole('textbox');
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: { getData: (type: string) => (type === 'text/plain' ? content : '') },
  });
  editor.dispatchEvent(event);
}

const status = () => screen.findByRole('status');

describe('DiaryPage', () => {
  it('says saved to the server only once the batch is acknowledged', async () => {
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

  it('says so when the diary does not exist for this user', async () => {
    openDiary(() =>
      Response.json({ error: { code: 'NOT_FOUND', message: 'No such diary' } }, { status: 404 }),
    );
    expect((await screen.findByRole('alert')).textContent).toBe('找不到这篇日记');
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
  const EPOCH = 'e1e1e1e1-0000-4000-8000-000000000001';
  const PARTNER = '6f1c1d0e-0000-4000-8000-000000000002';
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

  function openShared(share: 'live' | 'frozen', more: Parameters<typeof stubApi>[0] = {}) {
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal('navigator', { locks: stubLocks(), clipboard });
    stubApi({
      'GET /api/me': signedIn('alice'),
      'GET /api/spaces': () =>
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
        }),
      [`GET /api/diaries/${DIARY}/shares/${EPOCH}`]: sharedResponse(share),
      [`GET /api/diaries/${DIARY}/read`]: () => Response.json({ ranges: [] }),
      ...more,
    });
    renderAt(`/diaries/${DIARY}/shares/${EPOCH}`);
  }

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
    expect(within(legend).getByText('alice').className).toBe('author-slot-1');
    expect(within(legend).getByText('bob').className).toBe('author-slot-2');
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
    // so the whole text counts as on screen.
    Object.defineProperty(document, 'elementFromPoint', { value: () => null, configurable: true });
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
      vi.spyOn(editor.parentElement!, 'getBoundingClientRect').mockReturnValue({
        top: 0,
        bottom: 400,
        left: 0,
        right: 600,
      } as DOMRect);

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
    }
  });
});
