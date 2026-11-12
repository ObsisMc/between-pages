import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION } from '@between-pages/contracts';
import { DIARY, FakeSocket, GENERATION, diaryResponse, stubLocks } from '../../test/diary.ts';
import { stubApi } from '../../test/render.tsx';
import { createDiarySession, type DiaryState, type PageSource } from './session.ts';

const sessions: { destroy(): void }[] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) session.destroy();
  FakeSocket.reset();
  period = FIRST_PERIOD;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

const FIRST_PERIOD = '3e9a1c55-0000-4000-8000-000000000001';
const NEXT_PERIOD = '3e9a1c55-0000-4000-8000-000000000002';
/** The binding period the server reports; a test moves it to stand for unbinding and rebinding. */
let period = FIRST_PERIOD;

/** A shared page as the session loads it: empty, writable. */
const page: PageSource = {
  async load() {
    const { diary } = (await diaryResponse().json()) as { diary: { state: string } };
    return {
      readOnly: false,
      periodId: period,
      generationId: GENERATION,
      seq: 0,
      state: diary.state,
      bindings: [],
    };
  },
};

/** The batch the page sent last, and the server's answer that it never committed. */
function uncommitted() {
  const submit = FakeSocket.all.flatMap((s) => s.sent).findLast((m) => m.type === 'submit')!;
  const batchId = (submit as { batchId: string }).batchId;
  return {
    [`GET /api/diaries/${DIARY}/receipt?batchId=${batchId}`]: () =>
      Response.json({ receipt: null }),
  };
}

function open({
  userId = crypto.randomUUID() as string,
  server = diaryResponse as () => Response | Promise<Response>,
  locks = true,
  asPage = false,
} = {}) {
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('navigator', locks ? { locks: stubLocks() } : {});
  stubApi({ [`GET /api/diaries/${DIARY}`]: server });
  const place = document.createElement('div');
  document.body.append(place);
  const states: DiaryState[] = [];
  const session = createDiarySession({
    place,
    userId,
    diaryId: DIARY,
    ...(asPage ? { page } : {}),
    onChange: (state) => states.push(state),
  });
  sessions.push(session);
  return {
    session,
    place,
    state: () => states.at(-1),
    paste(content: string) {
      const event = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', {
        value: { getData: (type: string) => (type === 'text/plain' ? content : '') },
      });
      place.querySelector('.ProseMirror')!.dispatchEvent(event);
    },
  };
}

describe('diary session', () => {
  it('stores and sends what is written, and reports saved only after the ACK', async () => {
    const diary = open();
    await vi.waitFor(() => expect(diary.state()?.save).toBe('saved'));
    FakeSocket.answer = () => 'hold';

    diary.paste('今天下雨');
    expect(diary.session.text()).toBe('今天下雨');
    await vi.waitFor(() =>
      expect(FakeSocket.all[0]!.sent.some((m) => m.type === 'submit')).toBe(true),
    );
    expect(diary.state()?.save).toBe('syncing');
    FakeSocket.release();
    await vi.waitFor(() => expect(diary.state()).toMatchObject({ save: 'saved', unstored: 0 }));
    expect(FakeSocket.seq).toBe(1);
  });

  it('opens from this device when the server is unreachable, pending text included', async () => {
    FakeSocket.answer = () => 'INTERNAL';
    const userId = crypto.randomUUID();
    const first = open({ userId });
    await vi.waitFor(() => expect(first.state()?.phase).toBe('open'));
    first.paste('离线写的');
    await vi.waitFor(() => expect(first.state()?.unstored).toBe(0));
    first.session.destroy();

    const second = open({
      userId,
      server: () => Promise.reject(new TypeError('Failed to fetch')),
    });
    await vi.waitFor(() => expect(second.state()?.phase).toBe('open'));
    expect(second.session.text()).toBe('离线写的');
  });

  it('does not pretend to open a diary it has neither online nor stored', async () => {
    const offline = open({
      server: () => Promise.reject(new TypeError('Failed to fetch')),
    });
    await vi.waitFor(() =>
      expect(offline.state()).toMatchObject({ phase: 'failed', failure: 'offline' }),
    );
  });

  it('reports a diary the server does not show', async () => {
    const missing = open({
      server: () =>
        Response.json({ error: { code: 'NOT_FOUND', message: 'No such diary' } }, { status: 404 }),
    });
    await vi.waitFor(() =>
      expect(missing.state()).toMatchObject({ phase: 'failed', failure: 'NOT_FOUND' }),
    );
  });

  it('[adr:diary-collaboration-kernel#20] keeps refused text as a draft and takes it out of the editor', async () => {
    const diary = open();
    await vi.waitFor(() => expect(diary.state()?.save).toBe('saved'));
    FakeSocket.answer = () => 'EDIT_REJECTED';
    diary.paste('被拒的');

    await vi.waitFor(() => expect(diary.state()?.drafts).toHaveLength(1));
    expect(diary.state()!.drafts[0]).toMatchObject({
      reason: 'rejected',
      intent: [{ kind: 'insert', text: '被拒的' }],
    });
    await vi.waitFor(() => expect(diary.session.text()).toBe(''));

    FakeSocket.answer = () => 'ack';
    diary.paste('新的');
    await vi.waitFor(() => expect(FakeSocket.seq).toBe(1));
    await diary.session.deleteDrafts([diary.state()!.drafts[0]!.draftId]);
    expect(diary.state()?.drafts).toEqual([]);
  });

  for (const [code, why] of [
    ['NOT_FOUND', 'deleted'],
    ['SPACE_READ_ONLY', 'unbound'],
  ] as const)
    it(`[adr:shared-pages#10] closes a shared page ${why} under its writer, the refused text a draft`, async () => {
      const shared = open({ asPage: true });
      await vi.waitFor(() => expect(shared.state()?.save).toBe('saved'));
      FakeSocket.answer = () => code;

      shared.paste('被拒的字');

      await vi.waitFor(() => expect(shared.state()?.closed).toBe(code));
      expect(shared.place.querySelector('.ProseMirror')!.getAttribute('contenteditable')).toBe(
        'false',
      );
      await vi.waitFor(() => expect(shared.state()?.drafts).toHaveLength(1));
      expect(shared.state()!.drafts[0]).toMatchObject({
        reason: 'rejected',
        intent: [{ kind: 'insert', text: '被拒的字' }],
      });
      expect(FakeSocket.seq).toBe(0);
    });

  for (const [code, why] of [
    ['NOT_FOUND', 'deleted'],
    ['SPACE_READ_ONLY', 'unbound'],
  ] as const)
    it(`[adr:shared-pages#10] closes a shared page ${why} while away, its waiting text a draft`, async () => {
      const shared = open({ asPage: true });
      await vi.waitFor(() => expect(shared.state()?.save).toBe('saved'));
      FakeSocket.answer = () => 'hold';
      shared.paste('没发出去的');
      await vi.waitFor(() =>
        expect(FakeSocket.all[0]!.sent.some((m) => m.type === 'submit')).toBe(true),
      );

      // The subscription, not a submit, learns it: the page went while this device was away.
      FakeSocket.all[0]!.push({
        v: PROTOCOL_VERSION,
        type: 'error',
        diaryId: DIARY,
        code,
        message: 'no',
      });

      await vi.waitFor(() => expect(shared.state()?.closed).toBe(code));
      expect(shared.place.querySelector('.ProseMirror')!.getAttribute('contenteditable')).toBe(
        'false',
      );
      await vi.waitFor(() => expect(shared.state()?.drafts).toHaveLength(1));
      expect(shared.state()!.drafts[0]).toMatchObject({
        intent: [{ kind: 'insert', text: '没发出去的' }],
      });
    });

  it('[adr:shared-pages#10] does not send input from before an unbind and rebind, the page left open', async () => {
    const shared = open({ asPage: true });
    await vi.waitFor(() => expect(shared.state()?.save).toBe('saved'));
    FakeSocket.answer = () => 'hold';
    shared.paste('解绑前写的');
    await vi.waitFor(() =>
      expect(FakeSocket.all[0]!.sent.some((m) => m.type === 'submit')).toBe(true),
    );

    // Away while the two unbind and bind again; then the connection comes back.
    period = NEXT_PERIOD;
    FakeSocket.answer = () => 'ack';
    stubApi(uncommitted());
    FakeSocket.all[0]!.onclose?.({ code: 1006 });

    await vi.waitFor(() => expect(shared.state()?.drafts).toHaveLength(1), { timeout: 4000 });
    expect(shared.state()!.drafts[0]).toMatchObject({
      intent: [{ kind: 'insert', text: '解绑前写的' }],
    });
    await vi.waitFor(() => expect(shared.session.text()).toBe(''));
    expect(FakeSocket.seq).toBe(0);
  });

  it('[adr:shared-pages#10] does not send input left on this device before an unbind and rebind', async () => {
    const userId = crypto.randomUUID();
    const first = open({ userId, asPage: true });
    await vi.waitFor(() => expect(first.state()?.save).toBe('saved'));
    FakeSocket.answer = () => 'hold';
    first.paste('关掉前写的');
    await vi.waitFor(() =>
      expect(FakeSocket.all[0]!.sent.some((m) => m.type === 'submit')).toBe(true),
    );
    const receipts = uncommitted();
    first.session.destroy();

    // Reopened after the two unbound and bound again.
    period = NEXT_PERIOD;
    FakeSocket.answer = () => 'ack';
    const second = open({ userId, asPage: true });
    stubApi(receipts);

    await vi.waitFor(() => expect(second.state()?.drafts).toHaveLength(1));
    expect(second.state()!.drafts[0]).toMatchObject({
      intent: [{ kind: 'insert', text: '关掉前写的' }],
    });
    expect(second.session.text()).toBe('');
    expect(FakeSocket.seq).toBe(0);
  });

  it('keeps text it could not store on screen, guards leaving, and stores it once storage works', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const diary = open();
    await vi.waitFor(() => expect(diary.state()?.phase).toBe('open'));
    const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    });

    diary.paste('存不下');
    await vi.waitFor(() => expect(diary.state()).toMatchObject({ storeFailed: true, unstored: 1 }));
    expect(diary.session.text()).toBe('存不下');
    const leaving = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(leaving);
    expect(leaving.defaultPrevented).toBe(true);

    put.mockRestore();
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() =>
      expect(diary.state()).toMatchObject({ storeFailed: false, unstored: 0 }),
    );
    vi.useRealTimers();
    await vi.waitFor(() => expect(FakeSocket.seq).toBe(1));
  });

  it('is read-only without Web Locks', async () => {
    const diary = open({ locks: false });
    await vi.waitFor(() =>
      expect(diary.state()).toMatchObject({ phase: 'open', save: 'readonly' }),
    );
    expect(diary.place.querySelector('.ProseMirror')!.getAttribute('contenteditable')).toBe(
      'false',
    );
    diary.paste('写不了');
    expect(diary.session.text()).toBe('');
  });
});
