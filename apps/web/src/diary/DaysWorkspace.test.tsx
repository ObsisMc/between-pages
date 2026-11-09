import 'fake-indexeddb/auto';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Day } from '@between-pages/contracts';
import { FakeSocket, GENERATION, stubLocks } from '../../test/diary.ts';
import { stateOf, type Turn } from '../../test/day-text.ts';
import { renderAt, signedIn, stubApi } from '../../test/render.tsx';
import { ME, space } from '../../test/relationship.ts';
import { POSITION_MS } from '../day-feed/index.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NO_COPY = { connected: false, docUrl: null, mine: null, partner: null, problem: null };

/** A date with the caller's diary `n`. */
const dated = (diaryDate: string, n: number): Day => ({
  diaryDate,
  mine: {
    diaryId: id(n),
    excerpt: '',
    updatedAt: '2026-10-27T08:00:00Z',
    hasText: true,
    unread: false,
    sharedWithPartner: false,
    writing: false,
  },
  partner: null,
});
const page =
  (days: Day[], more: { nextBefore?: string; nextAfter?: string } = {}) =>
  () =>
    Response.json({ days, nextBefore: more.nextBefore ?? null, nextAfter: more.nextAfter ?? null });
/** The caller's diary `n` as the feed and the day read it. */
const ownDiary = (n: number, diaryDate: string, turns: Turn[] = []) => ({
  [`GET /api/diaries/${id(n)}`]: () =>
    Response.json({
      diary: {
        diaryId: id(n),
        diaryDate,
        ownerId: ME,
        generationId: GENERATION,
        seq: 0,
        ...stateOf(turns),
      },
    }),
  [`GET /api/diaries/${id(n)}/read`]: () => Response.json({ ranges: [] }),
});
/** The day's answer for a date without diaries of its own here. */
const emptyDay = (diaryDate: string) => ({
  [`GET /api/days/${diaryDate}`]: () =>
    Response.json({ day: { diaryDate, mine: null, partner: null }, google: NO_COPY }),
});

const DATES = ['2026-10-27', '2026-10-26', '2026-10-25', '2026-10-24'];
/** Four dates from the newest, each with an empty own diary. */
const fourDates = {
  'GET /api/me': signedIn('alice'),
  'GET /api/spaces': () => Response.json({ spaces: [space()] }),
  'GET /api/days': page(DATES.map((date, i) => dated(date, i + 1))),
  ...Object.assign({}, ...DATES.map((date, i) => ownDiary(i + 1, date))),
  ...Object.assign({}, ...DATES.map(emptyDay)),
};

/**
 * Lays the feed out in jsdom: its box is 600px high at the window's top, and each date is
 * 400px tall under the one before, moved up by the box's scrollTop.
 */
function layOut() {
  const tops = new WeakMap<Element, number>();
  Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
    configurable: true,
    get(this: Element) {
      return tops.get(this) ?? 0;
    },
    set(this: Element, value: number) {
      tops.set(this, value);
    },
  });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.classList.contains('day-feed-scroll')) return new DOMRect(0, 0, 300, 600);
    const box = this.closest('.day-feed-scroll');
    if (box && this instanceof HTMLElement && this.dataset.date) {
      const index = [...box.querySelectorAll('[data-date]')].indexOf(this);
      return new DOMRect(0, index * 400 - box.scrollTop, 300, 400);
    }
    return new DOMRect(0, 0, 0, 0);
  });
}

function narrowWindow() {
  vi.stubGlobal('matchMedia', (media: string) => ({
    matches: media === '(max-width: 56rem)',
    media,
    addEventListener() {},
    removeEventListener() {},
  }));
}

afterEach(async () => {
  cleanup();
  FakeSocket.reset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (HTMLElement.prototype as { scrollTop?: number }).scrollTop;
  await new Promise((resolve) => {
    indexedDB.deleteDatabase(`between-pages-journal:${ME}`).onsuccess = resolve;
  });
});

const feed = () => screen.findByRole('region', { name: '所有日记' });
const scrollerOf = (region: HTMLElement) => region.querySelector<HTMLElement>('.day-feed-scroll')!;
const dateOf = (region: HTMLElement, date: string) =>
  region.querySelector<HTMLElement>(`[data-date="${date}"]`)!;
const requested = (fetchMock: ReturnType<typeof stubApi>) =>
  fetchMock.mock.calls.map(([url, init]) => `${init?.method ?? 'GET'} ${String(url)}`);
/** The reader scrolls the list to `top` and lets it rest until it reports where it is. */
async function scrollTo(scroller: HTMLElement, top: number) {
  fireEvent.wheel(scroller);
  scroller.scrollTop = top;
  fireEvent.scroll(scroller);
  await act(() => new Promise((resolve) => setTimeout(resolve, POSITION_MS + 50)));
}
const index = () => screen.findByRole('navigation', { name: '日期索引' });
/** The feed's two answers around 2026-10-25, where it starts again when brought back there. */
const aroundOct25 = {
  'GET /api/days?before=2026-10-26': page([dated('2026-10-25', 3), dated('2026-10-24', 4)]),
  'GET /api/days?after=2026-10-25': page([dated('2026-10-27', 1), dated('2026-10-26', 2)]),
};
/** Chooses a date in the feed by its date link, as the reader would. */
const choose = (region: HTMLElement, date: string) =>
  fireEvent.click(within(dateOf(region, date)).getAllByRole('link')[0]!);

describe('DaysWorkspace', () => {
  it('[adr:digital-paper-interface#10] opens a date from the feed in the one main area, and 连续读 brings the feed back where it was', async () => {
    layOut();
    stubApi({ ...fourDates, ...aroundOct25 });
    const { router } = renderAt('/days');
    const region = await feed();
    await waitFor(() => expect(dateOf(region, '2026-10-24')).not.toBeNull());
    expect(await index()).toBeDefined();
    await scrollTo(scrollerOf(region), 800);
    expect(router.state.location.state).toMatchObject({ feed: { date: '2026-10-25', offset: 0 } });

    choose(region, '2026-10-24');
    await waitFor(() => expect(router.state.location.pathname).toBe('/days/2026-10-24'));
    expect(router.state.historyAction).toBe('PUSH');
    expect(await screen.findByRole('button', { name: '写这天' })).toBeDefined();
    // One main area: the day replaces the feed, the index stays, and the position is in the
    // history entry, never in the address.
    expect(screen.queryByRole('region', { name: '所有日记' })).toBeNull();
    const nav = await index();
    await waitFor(() =>
      expect(within(nav).getByRole('link', { current: 'page' }).getAttribute('href')).toBe(
        '/days/2026-10-24',
      ),
    );
    expect(router.state.location.search).toBe('');
    expect(screen.getByRole('link', { name: '这一天' }).getAttribute('aria-current')).toBe('page');

    fireEvent.click(screen.getByRole('link', { name: '连续读' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/days'));
    expect(router.state.historyAction).toBe('POP');
    const again = await feed();
    await waitFor(() => expect(scrollerOf(again).scrollTop).toBe(800));
    expect(dateOf(again, '2026-10-25').getBoundingClientRect().top).toBe(0);
  });

  it('[adr:digital-paper-interface#10] opens a date from the index or 这一天, and back brings the feed where it was', async () => {
    layOut();
    stubApi({ ...fourDates, ...aroundOct25 });
    const { router } = renderAt('/days');
    const region = await feed();
    await waitFor(() => expect(dateOf(region, '2026-10-24')).not.toBeNull());
    await scrollTo(scrollerOf(region), 800);

    fireEvent.click(await within(await index()).findByRole('link', { name: /^10 月 26 日/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/days/2026-10-26'));
    expect(router.state.historyAction).toBe('PUSH');
    expect(await screen.findByRole('button', { name: '写这天' })).toBeDefined();
    act(() => void router.navigate(-1));
    await waitFor(() => expect(router.state.location.pathname).toBe('/days'));
    await waitFor(() =>
      expect(scrollerOf(screen.getByRole('region', { name: '所有日记' })).scrollTop).toBe(800),
    );

    // "这一天" opens the date the feed is read at.
    fireEvent.click(screen.getByRole('link', { name: '这一天' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/days/2026-10-25'));
    fireEvent.click(await screen.findByRole('link', { name: '连续读' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/days'));
    const again = await feed();
    await waitFor(() => expect(scrollerOf(again).scrollTop).toBe(800));
  });

  it('[adr:digital-paper-interface#10] goes from one date to another in the index and still returns to the feed’s place', async () => {
    layOut();
    stubApi({ ...fourDates, ...aroundOct25 });
    const { router } = renderAt('/days');
    const region = await feed();
    await waitFor(() => expect(dateOf(region, '2026-10-24')).not.toBeNull());
    await scrollTo(scrollerOf(region), 800);
    choose(region, '2026-10-24');
    await waitFor(() => expect(router.state.location.pathname).toBe('/days/2026-10-24'));

    fireEvent.click(await within(await index()).findByRole('link', { name: /^10 月 26 日/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/days/2026-10-26'));
    fireEvent.click(screen.getByRole('link', { name: '连续读' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/days'));
    expect(router.state.historyAction).toBe('PUSH');
    const again = await feed();
    await waitFor(() => expect(scrollerOf(again).scrollTop).toBe(800));
  });

  it('[adr:book-frontend-workspace#4] opens a deep link to an empty date at once and never creates its diary', async () => {
    let answer!: () => void;
    const answered = new Promise<void>((resolve) => (answer = resolve));
    const later = (days: Day[]) => () => answered.then(page(days));
    const fetchMock = stubApi({
      ...fourDates,
      ...emptyDay('2026-10-05'),
      'GET /api/days?before=2026-10-06': later([dated('2026-10-03', 5)]),
      'GET /api/days?after=2026-10-05': later([dated('2026-10-08', 6)]),
    });
    renderAt('/days/2026-10-05');

    // The day does not wait for the index.
    expect(await screen.findByRole('button', { name: '写这天' })).toBeDefined();
    const nav = await index();
    expect(within(nav).getByText('正在读取…')).toBeDefined();

    answer();
    await waitFor(() =>
      expect(
        [...nav.querySelectorAll<HTMLElement>('[data-date]')].map((e) => e.dataset.date),
      ).toEqual(['2026-10-08', '2026-10-05', '2026-10-03']),
    );
    expect(within(nav).getByRole('link', { current: 'page' }).textContent).toContain(
      '没有可以读的日记',
    );
    const calls = requested(fetchMock);
    expect(calls).not.toContain('GET /api/days');
    expect(calls.filter((r) => r.startsWith('POST'))).toEqual([]);
  });

  it('[adr:book-frontend-workspace#4] loads a deep link’s index through StrictMode’s second mount, as in development', async () => {
    stubApi({
      ...fourDates,
      'GET /api/days?before=2026-10-26': page([dated('2026-10-25', 3)]),
      'GET /api/days?after=2026-10-25': page([dated('2026-10-27', 1)]),
    });
    renderAt('/days/2026-10-25', undefined, { strict: true });
    const nav = await index();
    await waitFor(() => expect(nav.querySelector('[data-date="2026-10-27"]')).not.toBeNull());
    expect(within(nav).queryByText('正在读取…')).toBeNull();
  });

  it('[adr:book-frontend-workspace#3] gives the day’s diary the focus on 编辑 only', async () => {
    stubApi(fourDates);
    const { router } = renderAt('/days');
    const region = await feed();
    await waitFor(() => expect(dateOf(region, '2026-10-25')).not.toBeNull());

    fireEvent.click(within(dateOf(region, '2026-10-25')).getByRole('link', { name: '编辑' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/days/2026-10-25'));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: '写这天' })),
    );

    fireEvent.click(await within(await index()).findByRole('link', { name: /^10 月 26 日/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/days/2026-10-26'));
    const write = await screen.findByRole('button', { name: '写这天' });
    expect(document.activeElement).not.toBe(write);
  });

  it('[adr:book-frontend-workspace#6] [adr:digital-paper-interface#10] narrow: folds the index into a date picker, and back from a date shows the feed where it was', async () => {
    narrowWindow();
    layOut();
    stubApi({ ...fourDates, ...aroundOct25 });
    const { router } = renderAt('/days');
    const region = await feed();
    await waitFor(() => expect(dateOf(region, '2026-10-24')).not.toBeNull());
    expect(screen.queryByRole('navigation', { name: '日期索引' })).toBeNull();
    expect(screen.getByRole('button', { name: '写今天' })).toBeDefined();
    await scrollTo(scrollerOf(region), 800);

    const picker = screen.getByRole('button', { name: '日期' });
    expect(picker.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(picker);
    fireEvent.click(await within(await index()).findByRole('link', { name: /^10 月 24 日/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/days/2026-10-24'));
    expect(await screen.findByRole('button', { name: '写这天' })).toBeDefined();
    expect(screen.queryByRole('region', { name: '所有日记' })).toBeNull();
    expect(screen.queryByRole('navigation', { name: '日期索引' })).toBeNull();

    fireEvent.click(screen.getByRole('link', { name: '连续读' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/days'));
    const again = await feed();
    await waitFor(() => expect(scrollerOf(again).scrollTop).toBe(800));
    expect(dateOf(again, '2026-10-25').getBoundingClientRect().top).toBe(0);
  });

  it('narrow: 连续读 from a deep link opens the feed at that date', async () => {
    narrowWindow();
    stubApi({
      ...fourDates,
      'GET /api/days?before=2026-10-26': page([dated('2026-10-25', 3)]),
      'GET /api/days?after=2026-10-25': page([dated('2026-10-27', 1)]),
    });
    const { router } = renderAt('/days/2026-10-25');
    expect(await screen.findByRole('button', { name: '写这天' })).toBeDefined();
    expect(screen.queryByRole('region', { name: '所有日记' })).toBeNull();

    fireEvent.click(screen.getByRole('link', { name: '连续读' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/days'));
    expect(router.state.historyAction).toBe('PUSH');
    const region = await feed();
    await waitFor(() => expect(dateOf(region, '2026-10-25')).not.toBeNull());
  });

  it('写今天 opens the date the server decides and gives its diary the focus', async () => {
    const opened = vi.fn(() =>
      Response.json({
        created: false,
        diary: {
          diaryId: id(1),
          diaryDate: '2026-10-27',
          ownerId: ME,
          generationId: GENERATION,
          seq: 0,
          ...stateOf([]),
        },
      }),
    );
    stubApi({ ...fourDates, 'POST /api/diaries': opened });
    const { router } = renderAt('/days');
    fireEvent.click(await screen.findByRole('button', { name: '写今天' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/days/2026-10-27'));
    expect(router.state.location.state).toMatchObject({ edit: true });
    const [init] = opened.mock.calls[0] as unknown as [RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
  });

  it('写今天 offline says it cannot confirm the diary and stays', async () => {
    stubApi({
      ...fourDates,
      'POST /api/diaries': () => Promise.reject(new TypeError('Failed to fetch')),
    });
    const { router } = renderAt('/days');
    fireEvent.click(await screen.findByRole('button', { name: '写今天' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      '离线时无法确认要打开的日记，请联网后再试',
    );
    expect(router.state.location.pathname).toBe('/days');
  });

  it('shows the day being written in the index as the editor has it, before the list reads again', async () => {
    // A deep link to a date the list has no diary for: the index asks around it and finds nothing.
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal('navigator', { locks: stubLocks() });
    const created = {
      diaryId: id(1),
      diaryDate: '2026-10-27',
      ownerId: ME,
      generationId: GENERATION,
      seq: 0,
    };
    stubApi({
      'GET /api/me': signedIn('alice'),
      'GET /api/spaces': () => Response.json({ spaces: [space()] }),
      'GET /api/days?before=2026-10-28': page([]),
      'GET /api/days?after=2026-10-27': page([]),
      ...emptyDay('2026-10-27'),
      'POST /api/diaries': () =>
        Response.json({ created: true, diary: { ...created, ...stateOf([]) } }),
      [`GET /api/diaries/${id(1)}`]: () =>
        Response.json({ diary: { ...created, ...stateOf([]), bindings: [] } }),
      [`GET /api/diaries/${id(1)}/read`]: () => Response.json({ ranges: [] }),
    });
    renderAt('/days/2026-10-27');
    const nav = await index();
    const row = () => nav.querySelector<HTMLElement>('[data-date="2026-10-27"]')!;
    await waitFor(() => expect(row().textContent).toContain('没有可以读的日记'));

    // 写这天 creates the diary: the index knows it at once, still blank.
    fireEvent.click(await screen.findByRole('button', { name: '写这天' }));
    const editor = await within(await screen.findByRole('region', { name: '我的日记' })).findByRole(
      'textbox',
    );
    await waitFor(() => expect(row().textContent).toContain('还没有写字'));
    expect(within(nav).queryByText('alice')).toBeNull();

    // Writing in it: the index shows the writer without any read of the day list.
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: { getData: (type: string) => (type === 'text/plain' ? '今天写了一点' : '') },
    });
    editor.dispatchEvent(event);
    await waitFor(() => expect(within(row()).getByText('alice')).toBeDefined());
    expect(row().textContent).not.toContain('还没有写字');
  });

  it('sends an address that is not a date to the feed', async () => {
    stubApi(fourDates);
    const { router } = renderAt('/days/yesterday');
    await waitFor(() => expect(router.state.location.pathname).toBe('/days'));
    expect(await feed()).toBeDefined();
  });
});
