import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { BODY, createDiaryDoc } from '@between-pages/collab';
import { PROTOCOL_VERSION } from '@between-pages/contracts';
import * as Y from 'yjs';
import { FakeSocket, stubLocks } from '../../test/diary.ts';
import { openJournal } from '../journal/index.ts';
import { renderAt, stubApi } from '../../test/render.tsx';

// The shared pages list, the deletion dialog (shared-pages D1, D3) and how the page's
// controls follow its editor. Writing itself is a diary session, tested through a real
// browser in e2e/shared-pages.spec.ts.

const ME = { id: '6f1c1d0e-0000-4000-8000-000000000001', displayName: 'alice' };
const PARTNER = { id: '6f1c1d0e-0000-4000-8000-000000000002', displayName: 'bo' };
const AT = '2026-11-04T08:00:00.000Z';
const ID = '0d0d0d0d-0000-4000-8000-000000000001';

const page = (over: object = {}) => ({
  id: ID,
  title: '旅行清单',
  authorId: ME.id,
  revision: 1,
  updatedAt: AT,
  renamed: null,
  unread: null,
  mark: 0,
  ...over,
});
const view = (over: object = {}) => ({
  me: ME,
  partner: PARTNER,
  readOnly: false,
  pages: [],
  notes: [],
  ...over,
});
const LIST = 'GET /api/shared-pages';
const opened = (over: object = {}, bindings: object[] = []) => ({
  page: page(),
  readOnly: false,
  periodId: '0d0d0d0d-0000-4000-8000-000000000003',
  generationId: '0d0d0d0d-0000-4000-8000-000000000002',
  seq: 0,
  state: 'AAA=',
  bindings,
  google: { connected: false, docUrl: null, coveredAt: null, problem: null },
  ...over,
});

const json = (body: object) => () => Response.json(body);
const fixed = {
  'GET /api/me': json({ user: ME }),
  'GET /api/binding': json({ binding: null, invitation: null, invitationsForMe: [] }),
  'GET /api/spaces': json({ spaces: [] }),
};

beforeEach(() =>
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      disconnect() {}
    },
  ),
);
afterEach(() => {
  cleanup();
  FakeSocket.reset();
  vi.unstubAllGlobals();
});

/** The open page with a live editor; `server` answers the page as it is now. */
function openPage(server: () => Response) {
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('navigator', { locks: stubLocks() });
  stubApi({
    ...fixed,
    [LIST]: json(view({ pages: [page()] })),
    [`GET /api/shared-pages/${ID}`]: server,
    'GET /api/space/unread': json({ features: { wishes: 0, anniversaries: 0, sharedPages: 0 } }),
  });
  return renderAt(`/shared-pages/${ID}`);
}
const editable = () => document.querySelector('.ProseMirror')?.getAttribute('contenteditable');
const NEXT_PERIOD = '0d0d0d0d-0000-4000-8000-000000000004';
const gone = () =>
  Response.json({ error: { code: 'NOT_FOUND', message: 'No such page' } }, { status: 404 });

describe('shared pages', () => {
  it('lists pages with what is new, and untitled ones by a stand-in name', async () => {
    stubApi({
      ...fixed,
      [LIST]: json(view({ pages: [page({ unread: 'new' }), page({ id: PARTNER.id, title: '' })] })),
    });
    renderAt('/shared-pages');
    expect((await screen.findByRole('link', { name: /旅行清单/ })).textContent).toContain('新');
    screen.getByRole('link', { name: /未命名页面/ });
  });

  it('marks a page the partner wrote in after the caller had read it', async () => {
    stubApi({ ...fixed, [LIST]: json(view({ pages: [page({ unread: 'acted', mark: 2 })] })) });
    renderAt('/shared-pages');
    expect((await screen.findByRole('link', { name: /旅行清单/ })).textContent).toContain('改过');
  });

  it('says what the partner deleted and what the caller had done there', async () => {
    stubApi({
      ...fixed,
      [LIST]: json(
        view({
          notes: [
            {
              id: ID,
              title: '旧清单',
              deleted: { by: PARTNER.id, at: AT },
              wrote: true,
              unread: true,
              mark: 3,
            },
          ],
        }),
      ),
    });
    renderAt('/shared-pages');
    await screen.findByText(/bo 删了"旧清单"（你写过）/);
  });

  it('offers no new page while unbound', async () => {
    stubApi({ ...fixed, [LIST]: json(view({ readOnly: true })) });
    renderAt('/shared-pages');
    await screen.findByText('已解绑，记录只读');
    expect(screen.queryByRole('button', { name: '新建一页' })).toBeNull();
  });

  it('closes the title and deletion with the editor when it learns of the unbinding', async () => {
    let unbound = false;
    openPage(() => Response.json(unbound ? opened({ readOnly: true, periodId: null }) : opened()));
    await screen.findByRole('button', { name: '删除' });
    await waitFor(() => expect(editable()).toBe('true'));
    await waitFor(() => expect(FakeSocket.all.length).toBeGreaterThan(0));

    unbound = true;
    FakeSocket.all.at(-1)!.push({
      v: PROTOCOL_VERSION,
      type: 'error',
      diaryId: ID,
      code: 'SPACE_READ_ONLY',
      message: 'no',
    });

    await waitFor(() => expect(screen.getByLabelText('页面标题')).toHaveProperty('disabled', true));
    expect(screen.queryByRole('button', { name: '删除' })).toBeNull();
    // The editor opened anew from the server, which says the space is unbound.
    await screen.findByText('已解绑，记录只读');
  });

  it('opens the editor writable again when the two bind again', async () => {
    let periodId: string | null = null;
    const { client } = openPage(() =>
      Response.json(opened({ readOnly: periodId === null, periodId })),
    );
    await screen.findByText('已解绑，记录只读');
    await waitFor(() => expect(editable()).toBe('false'));

    // Bound again; the page's next refresh sees the new period.
    periodId = NEXT_PERIOD;
    await client.invalidateQueries({ queryKey: ['shared-pages'] });

    await waitFor(() => expect(editable()).toBe('true'));
    expect(screen.queryByText('已解绑，记录只读')).toBeNull();
    expect(screen.getByLabelText('页面标题')).toHaveProperty('disabled', false);
  });

  it('takes away the title and deletion once the page is gone, its unsent words still there to copy', async () => {
    let deleted = false;
    const { client } = openPage(() => (deleted ? gone() : Response.json(opened())));
    await screen.findByRole('button', { name: '删除' });
    await waitFor(() => expect(editable()).toBe('true'));
    FakeSocket.answer = () => 'hold';
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', {
      value: { getData: (type: string) => (type === 'text/plain' ? '没发出去的字' : '') },
    });
    document.querySelector('.ProseMirror')!.dispatchEvent(paste);
    await waitFor(() =>
      expect(FakeSocket.all.at(-1)!.sent.some((m) => m.type === 'submit')).toBe(true),
    );

    deleted = true;
    await client.invalidateQueries({ queryKey: ['shared-pages'] });

    await screen.findByText('这一页已被删除');
    expect(screen.queryByLabelText('页面标题')).toBeNull();
    expect(screen.queryByRole('button', { name: '删除' })).toBeNull();
    await waitFor(() => expect(screen.getAllByText(/没发出去的字/).length).toBeGreaterThan(0));
    expect(editable()).toBe('false');
  });

  it('gives back only the input of pages the server says are gone, not of ones a stale list leaves out', async () => {
    const STILL_THERE = '0d0d0d0d-0000-4000-8000-000000000005';
    const DELETED = '0d0d0d0d-0000-4000-8000-000000000006';
    const GENERATION = '0d0d0d0d-0000-4000-8000-000000000002';
    // Input this device holds for two pages, neither in the list it is shown.
    const journal = await openJournal(ME.id);
    for (const [pageId, words] of [
      [STILL_THERE, '还开着的页'],
      [DELETED, '删掉的页'],
    ] as const) {
      const doc = createDiaryDoc();
      await journal.install({
        diaryId: pageId,
        page: true,
        generationId: GENERATION,
        seq: 0,
        state: Y.encodeStateAsUpdate(doc),
        bindings: [],
      });
      let update: Uint8Array = new Uint8Array();
      doc.once('update', (u: Uint8Array) => (update = u));
      doc.getText(BODY).insert(0, words);
      await journal.append(pageId, GENERATION, {
        operationId: crypto.randomUUID(),
        update,
        writtenAt: new Date(),
        intent: [{ kind: 'insert', text: words }],
      });
    }
    journal.close();
    stubApi({
      ...fixed,
      [LIST]: json(view()),
      [`GET /api/shared-pages/${STILL_THERE}`]: json(opened({ page: page({ id: STILL_THERE }) })),
      [`GET /api/shared-pages/${DELETED}`]: gone,
      [`GET /api/shared-pages/${ID}`]: json(opened()),
    });
    renderAt('/shared-pages');

    const left = await screen.findByRole('region', { name: '已删除页面里没保存的内容' });
    expect(left.textContent).toContain('删掉的页');
    expect(left.textContent).not.toContain('还开着的页');
  });

  it('says the page cannot open when the space cannot be read, and opens it on retry', async () => {
    let online = false;
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal('navigator', { locks: stubLocks() });
    stubApi({
      ...fixed,
      [LIST]: () =>
        online
          ? Response.json(view({ pages: [page()] }))
          : Promise.reject(new TypeError('offline')),
      [`GET /api/shared-pages/${ID}`]: json(opened()),
      'GET /api/space/unread': json({ features: { wishes: 0, anniversaries: 0, sharedPages: 0 } }),
    });
    renderAt(`/shared-pages/${ID}`);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('打不开这一页');
    online = true;
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(editable()).toBe('true'));
  });

  it("[adr:google-copy-beyond-diaries#9] shows the page's Doc in the caller's own Drive, and why it is behind", async () => {
    let google: object = {
      connected: true,
      docUrl: 'https://docs.google.com/document/d/doc-1/edit',
      coveredAt: '2026-11-18T01:22:00.000Z',
      problem: null,
    };
    const { client } = openPage(() => Response.json(opened({ google })));
    const link = await screen.findByRole('link', { name: '在 Google Docs 打开' });
    expect(link.getAttribute('href')).toBe('https://docs.google.com/document/d/doc-1/edit');
    expect(link.parentElement!.textContent).toMatch(/^已备份到 Google /);

    google = { ...google, problem: 'unreachable' };
    await act(() => client.invalidateQueries());
    await screen.findByText(/暂时连不上 Google，正在自动重试/);

    google = { connected: false, docUrl: null, coveredAt: null, problem: null };
    await act(() => client.invalidateQueries());
    await screen.findByText('未开启 Google 备份');
  });

  it('asks the server who wrote in the page before confirming its deletion', async () => {
    let partnerWrote = false;
    openPage(() =>
      Response.json(opened({}, partnerWrote ? [{ clientId: 7, userId: PARTNER.id }] : [])),
    );
    await screen.findByRole('button', { name: '删除' });

    // The partner's first words arrive after the page was last read.
    partnerWrote = true;
    fireEvent.click(screen.getByRole('button', { name: '删除' }));

    await screen.findByText('TA 写的内容也会一起消失。');
    // Already in both Drives, so deleting here takes nothing out of the partner's
    // (google-copy-beyond-diaries D8).
    screen.getByText('已经备份到对方 Google Drive 的内容不会因此删除。');
    expect(screen.getByRole('button', { name: '确认删除' })).toHaveProperty('disabled', false);
  });

  it('warns before deleting a page the partner wrote in, and reports the page seen on opening', async () => {
    const api = stubApi({
      ...fixed,
      [LIST]: json(view({ pages: [page()] })),
      [`GET /api/shared-pages/${ID}`]: json(
        opened({ page: page({ unread: 'acted', mark: 2 }) }, [{ clientId: 7, userId: PARTNER.id }]),
      ),
      'POST /api/space/seen': json({ recorded: true }),
      'GET /api/space/unread': json({ features: { wishes: 0, anniversaries: 0, sharedPages: 0 } }),
    });
    renderAt(`/shared-pages/${ID}`);
    fireEvent.click(await screen.findByRole('button', { name: '删除' }));
    await screen.findByText('TA 写的内容也会一起消失。');
    await waitFor(() => {
      const seen = api.mock.calls.find(([url]) => String(url) === '/api/space/seen');
      expect(JSON.parse(String(seen?.[1]?.body))).toEqual({
        records: [{ type: 'shared_page', id: ID, mark: 2 }],
      });
    });
  });
});
