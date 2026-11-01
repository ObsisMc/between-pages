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
  { title: '管理', entries: [{ to: '/c', label: '丙页' }] },
];

const page = (name: string) => <p>{name}的正文</p>;
const routes = [
  {
    element: (
      <>
        <Outlet />
        <ContentsBookmark>
          <ContentsPages groups={groups} />
        </ContentsBookmark>
      </>
    ),
    children: [
      { path: '/', element: page('序言') },
      { path: '/a', element: page('甲') },
      { path: '/b', element: page('乙') },
      { path: '/c', element: page('丙') },
    ],
  },
];

const bookmark = () => screen.getByRole('button', { name: '目录' });
const openContents = async () => {
  fireEvent.click(bookmark());
  return screen.findByRole('dialog', { name: '目录' });
};

afterEach(cleanup);

describe('BookSpread', () => {
  it('[adr:book-frontend-workspace#1] keeps each page in its own container', () => {
    renderAt('/', [{ path: '/', element: <BookSpread left={page('左')} right={page('右')} /> }]);
    const left = screen.getByText('左的正文').parentElement!;
    const right = screen.getByText('右的正文').parentElement!;
    expect(left.className).toBe('book-page book-left');
    expect(right.className).toBe('book-page book-right');
    expect(left.contains(right) || right.contains(left)).toBe(false);
  });
});

describe('ContentsBookmark', () => {
  it('opens the contents from the bookmark with focus inside, listing the entries the caller gave', async () => {
    renderAt('/a', routes);
    expect(bookmark().getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('dialog')).toBeNull();

    const dialog = await openContents();
    expect(bookmark().getAttribute('aria-expanded')).toBe('true');
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    expect(
      within(dialog)
        .getAllByRole('heading')
        .map((h) => h.textContent),
    ).toEqual(['目录', '日记', '管理']);
    expect(
      within(dialog)
        .getAllByRole('link')
        .map((a) => [a.textContent, a.getAttribute('href')]),
    ).toEqual([
      ['← 返回序言', '/'],
      ['甲页→', '/a'],
      ['乙页→', '/b'],
      ['丙页→', '/c'],
    ]);
    expect(within(dialog).getByLabelText('有新内容')).toBeDefined();
    // The page being read stays mounted underneath.
    expect(screen.getByText('甲的正文')).toBeDefined();
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
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(router.state.location.pathname).toBe('/a');
    expect(router.state.location.state).toBeNull();
  });

  it('closes on Escape and gives focus back to the bookmark, on the same page', async () => {
    const { router } = renderAt('/a', routes);
    const dialog = await openContents();
    fireEvent.keyDown(within(dialog).getByRole('link', { name: /乙页/ }), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
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
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(router.state.location.pathname).toBe('/a');
  });

  it("closes with the browser's back button, staying on the page", async () => {
    const { router } = renderAt('/a', routes);
    await openContents();
    await router.navigate(-1);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(router.state.location.pathname).toBe('/a');
    expect(document.activeElement).toBe(bookmark());
  });

  it('closes with the close button and with the bookmark itself', async () => {
    renderAt('/a', routes);
    fireEvent.click(within(await openContents()).getByRole('button', { name: '合上目录' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await openContents();
    fireEvent.click(bookmark());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('goes to an entry in place of the open contents, so back returns to the page it was opened on', async () => {
    const { router } = renderAt('/', routes);
    await router.navigate('/a');
    fireEvent.click(within(await openContents()).getByRole('link', { name: /丙页/ }));
    expect(await screen.findByText('丙的正文')).toBeDefined();
    expect(screen.queryByRole('dialog')).toBeNull();

    await router.navigate(-1);
    expect(await screen.findByText('甲的正文')).toBeDefined();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps Tab inside the open contents', async () => {
    renderAt('/a', routes);
    const dialog = await openContents();
    const home = within(dialog).getByRole('link', { name: '返回序言' });
    const close = within(dialog).getByRole('button', { name: '合上目录' });

    close.focus();
    fireEvent.keyDown(close, { key: 'Tab' });
    expect(document.activeElement).toBe(home);

    fireEvent.keyDown(home, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(close);
  });
});
