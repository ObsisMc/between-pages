import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { noRelationship, renderAt, signedIn, signedOut, stubApi } from '../../test/render.tsx';
import { SPACE, space } from '../../test/relationship.ts';

const today = new Intl.DateTimeFormat('en-CA').format(new Date());

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Opens the contents from the bookmark and lists it as { group: [label, href][] }. */
async function contents() {
  fireEvent.click(await screen.findByRole('button', { name: '目录' }));
  const dialog = await screen.findByRole('dialog', { name: '目录' });
  const listed = () =>
    Object.fromEntries(
      within(dialog)
        .getAllByRole('region')
        .map((group) => [
          group.querySelector('h3')!.textContent,
          within(group)
            .getAllByRole('link')
            .map((a) => [a.querySelector('.contents-label')!.textContent, a.getAttribute('href')]),
        ]),
    );
  return { dialog, listed };
}

describe('SiteBookmark', () => {
  it('[adr:space-records#10] [adr:book-frontend-workspace#2] lists only the diaries and backup for an account that was never bound', async () => {
    stubApi({ ...noRelationship, 'GET /api/me': signedIn('alice') });
    renderAt('/');
    const { listed } = await contents();
    await waitFor(() =>
      expect(listed()).toEqual({
        日记: [
          ['今天的日记', `/days/${today}`],
          ['所有日记', '/days'],
        ],
        管理: [['备份', '/backup']],
      }),
    );
  });

  it('lists the clocks, the space features with their dots and the space while bound', async () => {
    stubApi({
      ...noRelationship,
      'GET /api/me': signedIn('alice'),
      'GET /api/binding': () =>
        Response.json({ binding: { space: space(), periodId: SPACE }, invitation: null }),
      'GET /api/spaces': () => Response.json({ spaces: [space()] }),
      'GET /api/space/unread': () => Response.json({ features: { wishes: 2, anniversaries: 0 } }),
    });
    renderAt('/backup');
    const { dialog, listed } = await contents();
    await waitFor(() =>
      expect(listed()).toEqual({
        日记: [
          ['今天的日记', `/days/${today}`],
          ['所有日记', '/days'],
        ],
        一起: [
          ['两地时间', '/clocks'],
          ['心愿与礼物', '/wishes'],
          ['纪念日', '/anniversaries'],
        ],
        管理: [
          ['双人空间', `/spaces/${SPACE}`],
          ['备份', '/backup'],
        ],
      }),
    );
    const wishes = within(dialog).getByRole('link', { name: /心愿与礼物/ });
    await waitFor(() => expect(within(wishes).queryByLabelText('有新内容')).not.toBeNull());
    expect(
      within(within(dialog).getByRole('link', { name: /纪念日/ })).queryByLabelText('有新内容'),
    ).toBeNull();
    expect(within(dialog).getByRole('link', { name: /备份/ }).getAttribute('aria-current')).toBe(
      'page',
    );
  });

  it('[adr:book-frontend-workspace#7] keeps the read-only space and its records after unbinding, without the clocks', async () => {
    stubApi({
      ...noRelationship,
      'GET /api/me': signedIn('alice'),
      'GET /api/spaces': () => Response.json({ spaces: [space('archived')] }),
      'GET /api/space/unread': () => Response.json({ features: { wishes: 0, anniversaries: 0 } }),
    });
    renderAt('/');
    const { listed } = await contents();
    await waitFor(() =>
      expect(listed()).toEqual({
        日记: [
          ['今天的日记', `/days/${today}`],
          ['所有日记', '/days'],
        ],
        一起: [
          ['心愿与礼物', '/wishes'],
          ['纪念日', '/anniversaries'],
        ],
        管理: [
          ['双人空间', `/spaces/${SPACE}`],
          ['备份', '/backup'],
        ],
      }),
    );
  });

  it('shows no bookmark while signed out', async () => {
    stubApi({ 'GET /api/me': signedOut });
    renderAt('/login');
    expect(await screen.findByText('使用 Google 登录')).toBeDefined();
    expect(screen.queryByRole('button', { name: '目录' })).toBeNull();
  });
});
