import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Outlet } from 'react-router';
import { renderAt } from '../../test/render.tsx';
import { BookSpread, ContentsBookmark, ContentsPages, type ContentsGroup } from './index.ts';

const groups: ContentsGroup[] = [
  {
    title: '日记',
    entries: [
      { to: '/a', label: '甲页' },
      { to: '/b', label: '乙页', badge: <span role="img" aria-label="有新内容" /> },
    ],
  },
  { title: '一起', side: 'right', entries: [{ to: '/d', label: '丁页' }] },
  { title: '管理', icons: true, entries: [{ to: '/c', label: '丙页', icon: 'backup' }] },
];

const page = (name: string) => <p>{name}的正文</p>;
const routes = [
  {
    element: (
      <ContentsBookmark contents={<ContentsPages groups={groups} />}>
        <Outlet />
      </ContentsBookmark>
    ),
    children: [
      { path: '/', element: page('序言') },
      {
        path: '/draft',
        element: (
          <div style={{ overflowY: 'auto' }} data-testid="box">
            <input aria-label="草稿" />
          </div>
        ),
      },
      { path: '/a', element: page('甲') },
      { path: '/b', element: page('乙') },
      { path: '/c', element: page('丙') },
    ],
  },
];

const bookmark = () => screen.getByRole('button', { name: '目录' });
const openContents = async () => {
  fireEvent.click(bookmark());
  return screen.findByRole('main', { name: '目录' });
};
const contents = () => screen.queryByRole('main', { name: '目录' });

afterEach(cleanup);

describe('BookSpread', () => {
  it('[adr:book-frontend-workspace#1] [adr:book-surface#1] keeps each page in its own container', () => {
    renderAt('/', [{ path: '/', element: <BookSpread left={page('左')} right={page('右')} /> }]);
    const left = screen.getByText('左的正文').closest('.book-page')!;
    const right = screen.getByText('右的正文').closest('.book-page')!;
    expect(left.className).toBe('book-page book-left');
    expect(right.className).toBe('book-page book-right');
    expect(left.contains(right) || right.contains(left)).toBe(false);
  });
});

describe('ContentsBookmark', () => {
  it('[adr:contents-spread#3] opens the contents as a page over an inert one, its title focused, listing the entries the caller gave', async () => {
    renderAt('/a', routes);
    expect(bookmark().getAttribute('aria-expanded')).toBe('false');
    expect(contents()).toBeNull();

    const dialog = await openContents();
    expect(bookmark().getAttribute('aria-expanded')).toBe('true');
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(within(dialog).getByRole('heading', { name: '目录' })),
    );
    // Left page first, then the right; numbers run across both, icons take none.
    expect(
      within(dialog)
        .getAllByRole('heading')
        .map((h) => h.textContent),
    ).toEqual(['目录', '日记', '管理', '一起']);
    expect(
      within(dialog)
        .getAllByRole('link')
        .map((a) => [a.textContent, a.getAttribute('href')]),
    ).toEqual([
      ['← 返回序言', '/'],
      ['01甲页→', '/a'],
      ['02乙页→', '/b'],
      ['丙页→', '/c'],
      ['03丁页→', '/d'],
    ]);
    expect(within(dialog).getByLabelText('有新内容')).toBeDefined();
    // The page being read stays mounted underneath, out of reach.
    expect(screen.getByText('甲的正文').closest('[inert]')).not.toBeNull();
    expect(dialog.closest('[inert]')).toBeNull();
    expect(bookmark().closest('[inert]')).toBeNull();
  });

  it('[adr:contents-spread#1] gives back the page underneath as it was, with what was typed and scrolled', async () => {
    renderAt('/draft', routes);
    const draft = screen.getByLabelText('草稿') as HTMLInputElement;
    fireEvent.change(draft, { target: { value: '写到一半' } });
    screen.getByTestId('box').scrollTop = 120;

    fireEvent.click(within(await openContents()).getByRole('button', { name: '合上目录' }));
    await waitFor(() => expect(contents()).toBeNull());
    expect(screen.getByLabelText('草稿')).toBe(draft);
    expect(draft.value).toBe('写到一半');
    expect(screen.getByTestId('box').scrollTop).toBe(120);
    expect(draft.closest('[inert]')).toBeNull();
    expect(document.activeElement).toBe(bookmark());
  });

  it('marks the page already showing as current, and choosing it only closes the contents', async () => {
    const { router } = renderAt('/a', routes);
    const dialog = await openContents();
    const current = within(dialog).getByRole('link', { name: /甲页/ });
    expect(current.getAttribute('aria-current')).toBe('page');
    expect(within(dialog).getByRole('link', { name: /乙页/ }).getAttribute('aria-current')).toBe(
      null,
    );

    fireEvent.click(current);
    await waitFor(() => expect(contents()).toBeNull());
    expect(router.state.location.pathname).toBe('/a');
    expect(router.state.location.state).toBeNull();
  });

  it('[adr:contents-spread#2] closes on Escape and gives focus back to the bookmark, on the same page', async () => {
    const { router } = renderAt('/a', routes);
    const dialog = await openContents();
    fireEvent.keyDown(within(dialog).getByRole('link', { name: /乙页/ }), { key: 'Escape' });
    await waitFor(() => expect(contents()).toBeNull());
    expect(router.state.location.pathname).toBe('/a');
    expect(document.activeElement).toBe(bookmark());

    // A second Escape after it closed changes nothing.
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(router.state.location.pathname).toBe('/a');
  });

  it('closes on two quick Escapes without leaving the page', async () => {
    const { router } = renderAt('/', routes);
    await router.navigate('/a');
    await openContents();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() => expect(contents()).toBeNull());
    expect(router.state.location.pathname).toBe('/a');
  });

  it("[adr:contents-spread#2] closes with the browser's back button, staying on the page", async () => {
    const { router } = renderAt('/a', routes);
    await openContents();
    await router.navigate(-1);
    await waitFor(() => expect(contents()).toBeNull());
    expect(router.state.location.pathname).toBe('/a');
    expect(document.activeElement).toBe(bookmark());
  });

  it('[adr:contents-spread#2] closes with the close button and with the bookmark itself', async () => {
    renderAt('/a', routes);
    fireEvent.click(within(await openContents()).getByRole('button', { name: '合上目录' }));
    await waitFor(() => expect(contents()).toBeNull());

    await openContents();
    fireEvent.click(bookmark());
    await waitFor(() => expect(contents()).toBeNull());
  });

  it('[adr:contents-spread#2] goes to an entry in place of the open contents, so back returns to the page it was opened on', async () => {
    const { router } = renderAt('/', routes);
    await router.navigate('/a');
    fireEvent.click(within(await openContents()).getByRole('link', { name: /丙页/ }));
    expect(await screen.findByText('丙的正文')).toBeDefined();
    expect(contents()).toBeNull();

    await router.navigate(-1);
    expect(await screen.findByText('甲的正文')).toBeDefined();
    expect(contents()).toBeNull();
  });
});
