import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderAt, stubApi } from '../../test/render.tsx';

// The shared pages list and the deletion dialog (shared-pages D1, D3). Writing itself is a
// diary session, tested through a real browser in e2e/shared-pages.spec.ts.

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
  generationId: '0d0d0d0d-0000-4000-8000-000000000002',
  seq: 0,
  state: 'AAA=',
  bindings,
  ...over,
});

const json = (body: object) => () => Response.json(body);
const fixed = {
  'GET /api/me': json({ user: ME }),
  'GET /api/binding': json({ binding: null, invitation: null }),
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
  vi.unstubAllGlobals();
});

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
