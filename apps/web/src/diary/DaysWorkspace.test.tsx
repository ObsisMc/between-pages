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
/** The caller's diary `n` as the feed and the left page read it. */
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
/** The left page's answer for a date without diaries of its own here. */
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
/** Chooses a date in the feed by its date link, as the reader would. */
const choose = (region: HTMLElement, date: string) =>
  fireEvent.click(within(dateOf(region, date)).getAllByRole('link')[0]!);

describe('DaysWorkspace', () => {
  it('[adr:book-frontend-workspace#3] edits a chosen date in the left page while the feed keeps its place, and back brings both again', async () => {
    layOut();
    const fetchMock = stubApi(fourDates);
    const { router } = renderAt('/days');
    expect(await screen.findByText('从右页选一天')).toBeDefined();
    expect(screen.getByRole('button', { name: '写今天' })).toBeDefined();
    const region = await feed();
    await waitFor(() => expect(dateOf(region, '2026-10-24')).not.toBeNull());
    const scroller = scrollerOf(region);

    await scrollTo(scroller, 800);
    expect(router.state.location.state).toMatchObject({ feed: { date: '2026-10-25', offset: 0 } });

    choose(region, '2026-10-24');
    await waitFor(() => expect(router.state.location.pathname).toBe('/days/2026-10-24'));
    expect(router.state.historyAction).toBe('PUSH');
    expect(await screen.findByRole('button', { name: '写这天' })).toBeDefined();
    expect(screen.queryByText('从右页选一天')).toBeNull();
    // The same list, where it was, and the chosen date said in words.
    expect(scrollerOf(await feed())).toBe(scroller);
    expect(scroller.scrollTop).toBe(800);
    const chosen = dateOf(region, '2026-10-24');
    expect(within(chosen).getByText('在左页')).toBeDefined();
    expect(within(chosen).getAllByRole('link')[0]!.getAttribute('aria-current')).toBe('true');
    expect(requested(fetchMock).filter((r) => r.startsWith('GET /api/days?'))).toEqual([]);
    expect(requested(fetchMock).filter((r) => r === 'GET /api/days')).toHaveLength(1);

    await scrollTo(scroller, 0);
    act(() => void router.navigate(-1));
    await waitFor(() => expect(router.state.location.pathname).toBe('/days'));
    expect(await screen.findByText('从右页选一天')).toBeDefined();
    await waitFor(() => expect(scroller.scrollTop).toBe(800));
    expect(dateOf(region, '2026-10-24').classList.contains('chosen')).toBe(false);
  });

  it('[adr:book-frontend-workspace#4] opens a deep link to an empty date in the left page at once and never creates its diary', async () => {
    let answer!: () => void;
    const answered = new Promise<void>((resolve) => (answer = resolve));
    const later = (days: Day[]) => () => answered.then(page(days));
    const fetchMock = stubApi({
      ...fourDates,
      ...emptyDay('2026-10-05'),
      'GET /api/days?before=2026-10-06': later([dated('2026-10-03', 5)]),
      'GET /api/days?after=2026-10-05': later([dated('2026-10-08', 6)]),
      ...ownDiary(5, '2026-10-03'),
      ...ownDiary(6, '2026-10-08'),
    });
    renderAt('/days/2026-10-05');

    // The left page does not wait for the list.
    expect(await screen.findByRole('button', { name: '写这天' })).toBeDefined();
    const region = await feed();
    expect(within(region).getByText('正在读取…')).toBeDefined();

    answer();
    await waitFor(() => expect(dateOf(region, '2026-10-05')).not.toBeNull());
    expect(within(dateOf(region, '2026-10-05')).getByText('这一天没有可以读的日记')).toBeDefined();
    expect(within(dateOf(region, '2026-10-05')).getByText('在左页')).toBeDefined();
    expect(
      [...region.querySelectorAll<HTMLElement>('[data-date]')].map((e) => e.dataset.date),
    ).toEqual(['2026-10-08', '2026-10-05', '2026-10-03']);
    const calls = requested(fetchMock);
    expect(calls).not.toContain('GET /api/days');
    expect(calls.filter((r) => r.startsWith('POST'))).toEqual([]);
  });

  it('[adr:book-frontend-workspace#9] collapses the own diary open in the left page and reads it afresh once the left page moves on', async () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal('navigator', { locks: stubLocks() });
    const today = dated('2026-10-27', 1);
    stubApi({
      ...fourDates,
      ...ownDiary(1, '2026-10-27', [[1, ME, '左页写的字']]),
      'GET /api/days/2026-10-27': () => Response.json({ day: today, google: NO_COPY }),
      'GET /api/days?before=2026-10-28': page([today, dated('2026-10-26', 2)]),
      'GET /api/days?after=2026-10-27': page([]),
    });
    renderAt('/days/2026-10-27');

    const own = await screen.findByRole('region', { name: '我的日记' });
    const editor = await within(own).findByRole('textbox');
    await waitFor(() => expect(editor.textContent).toBe('左页写的字'));
    const region = await feed();
    const day = await waitFor(() => {
      const section = dateOf(region, '2026-10-27');
      expect(section).not.toBeNull();
      return section;
    });
    expect(within(day).getByText('正在左页编辑')).toBeDefined();
    expect(day.textContent).not.toContain('左页写的字');

    choose(region, '2026-10-26');
    await waitFor(() => expect(dateOf(region, '2026-10-27').textContent).toContain('左页写的字'));
    expect(within(dateOf(region, '2026-10-27')).queryByText('正在左页编辑')).toBeNull();
  });

  it('[adr:book-frontend-workspace#3] hands the focus to the left page’s diary only on 编辑', async () => {
    stubApi(fourDates);
    const { router } = renderAt('/days');
    const region = await feed();
    await waitFor(() => expect(dateOf(region, '2026-10-26')).not.toBeNull());

    choose(region, '2026-10-26');
    const write = await screen.findByRole('button', { name: '写这天' });
    expect(document.activeElement).not.toBe(write);

    fireEvent.click(within(dateOf(region, '2026-10-25')).getByRole('link', { name: '编辑' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/days/2026-10-25'));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: '写这天' })),
    );
  });

  it('[adr:book-frontend-workspace#6] narrow: goes from the feed to one page for the date and back to the same place', async () => {
    narrowWindow();
    layOut();
    stubApi({
      ...fourDates,
      // Back on the feed, it starts again around the date it was read at.
      'GET /api/days?before=2026-10-26': page([dated('2026-10-25', 3), dated('2026-10-24', 4)]),
      'GET /api/days?after=2026-10-25': page([dated('2026-10-27', 1), dated('2026-10-26', 2)]),
    });
    const { router } = renderAt('/days');
    const region = await feed();
    await waitFor(() => expect(dateOf(region, '2026-10-24')).not.toBeNull());
    expect(screen.getByRole('button', { name: '目录' })).toBeDefined();
    expect(screen.getByRole('button', { name: '写今天' })).toBeDefined();
    expect(screen.queryByText('从右页选一天')).toBeNull();
    await scrollTo(scrollerOf(region), 800);

    fireEvent.click(within(dateOf(region, '2026-10-24')).getByRole('link', { name: '编辑' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/days/2026-10-24'));
    const write = await screen.findByRole('button', { name: '写这天' });
    await waitFor(() => expect(document.activeElement).toBe(write));
    expect(screen.queryByRole('region', { name: '所有日记' })).toBeNull();
    expect(screen.getByRole('button', { name: '目录' })).toBeDefined();

    fireEvent.click(screen.getByRole('link', { name: '← 所有日记' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/days'));
    const again = await feed();
    await waitFor(() => expect(scrollerOf(again).scrollTop).toBe(800));
    expect(dateOf(again, '2026-10-25').getBoundingClientRect().top).toBe(0);
  });

  it('narrow: "← 所有日记" from a deep link opens the feed at that date', async () => {
    narrowWindow();
    stubApi({
      ...fourDates,
      'GET /api/days?before=2026-10-26': page([dated('2026-10-25', 3)]),
      'GET /api/days?after=2026-10-25': page([dated('2026-10-27', 1)]),
    });
    const { router } = renderAt('/days/2026-10-25');
    expect(await screen.findByRole('button', { name: '写这天' })).toBeDefined();
    expect(screen.queryByRole('region', { name: '所有日记' })).toBeNull();

    fireEvent.click(screen.getByRole('link', { name: '← 所有日记' }));
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

  it('sends an address that is not a date to the feed', async () => {
    stubApi(fourDates);
    const { router } = renderAt('/days/yesterday');
    await waitFor(() => expect(router.state.location.pathname).toBe('/days'));
    expect(await screen.findByText('从右页选一天')).toBeDefined();
  });
});
