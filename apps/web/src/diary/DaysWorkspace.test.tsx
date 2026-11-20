import 'fake-indexeddb/auto';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Day } from '@between-pages/contracts';
import { FakeSocket, GENERATION, stubLocks } from '../../test/diary.ts';
import { stateOf, type Turn } from '../../test/day-text.ts';
import { renderAt, signedIn, stubApi } from '../../test/render.tsx';
import { ME, PARTNER, space } from '../../test/relationship.ts';
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

  describe('补写…', () => {
    /** The day the device is on: 2026-10-27, wherever it is. */
    const onOct27 = () =>
      vi.useFakeTimers({ now: new Date('2026-10-27T12:00:00Z'), toFake: ['Date'] });
    afterEach(() => vi.useRealTimers());
    const partnerOnly = (diaryDate: string): Day => ({
      diaryDate,
      mine: null,
      partner: { ...dated(diaryDate, 9).mine!, epochId: id(10), share: 'live' },
    });
    /** October from the day list: the four own dates, and one the partner alone wrote. */
    const october = {
      'GET /api/days?before=2026-11-01': page([
        ...DATES.map((date, i) => dated(date, i + 1)),
        partnerOnly('2026-10-20'),
      ]),
    };
    const day = (name: string) => screen.findByRole('button', { name });
    const openedOn = (diaryDate: string) => ({
      diary: {
        diaryId: id(5),
        diaryDate,
        ownerId: ME,
        generationId: GENERATION,
        seq: 0,
        ...stateOf([]),
      },
    });

    it('DATE-06 offers the days up to today, dotting the ones the caller wrote', async () => {
      onOct27();
      stubApi({ ...fourDates, ...october });
      renderAt('/days');
      fireEvent.click(await screen.findByRole('button', { name: '补写…' }));
      const calendar = await screen.findByRole('dialog', { name: '补写哪一天' });
      expect(within(calendar).getByText('2026 年 10 月')).toBeDefined();
      expect(await day('10 月 26 日，你写过')).toBeDefined();
      expect(await day('10 月 27 日，你写过，今天')).toBeDefined();
      // The partner's diary alone does not mark the day as the caller's.
      expect(screen.getByRole('button', { name: '10 月 20 日' })).toBeDefined();
      expect(
        (screen.getByRole('button', { name: '10 月 28 日，还没到' }) as HTMLButtonElement).disabled,
      ).toBe(true);
      // No later month to page to.
      expect(screen.getByRole('button', { name: '下个月' }).getAttribute('aria-disabled')).toBe(
        'true',
      );
    });

    it('DATE-06 opens the chosen day’s own diary for writing', async () => {
      onOct27();
      const opened = vi.fn(() => Response.json({ created: true, ...openedOn('2026-10-20') }));
      stubApi({
        ...fourDates,
        ...october,
        ...emptyDay('2026-10-20'),
        'GET /api/days?before=2026-10-21': page([]),
        'GET /api/days?after=2026-10-20': page([]),
        'POST /api/diaries': opened,
      });
      const { router } = renderAt('/days');
      fireEvent.click(await screen.findByRole('button', { name: '补写…' }));
      fireEvent.click(await day('10 月 20 日'));
      await waitFor(() => expect(router.state.location.pathname).toBe('/days/2026-10-20'));
      expect(router.state.location.state).toMatchObject({ edit: true, back: true });
      const [init] = opened.mock.calls[0] as unknown as [RequestInit];
      expect(JSON.parse(String(init.body))).toEqual({
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        date: '2026-10-20',
      });
      expect(screen.queryByRole('dialog', { name: '补写哪一天' })).toBeNull();
    });

    it('says the day has not begun here when the server refuses it, and stays', async () => {
      onOct27();
      stubApi({
        ...fourDates,
        ...october,
        'POST /api/diaries': () =>
          Response.json(
            { error: { code: 'VALIDATION_FAILED', message: 'future' } },
            { status: 400 },
          ),
      });
      const { router } = renderAt('/days');
      fireEvent.click(await screen.findByRole('button', { name: '补写…' }));
      fireEvent.click(await day('10 月 27 日，你写过，今天'));
      expect((await screen.findByRole('alert')).textContent).toBe('你这边还没到这一天');
      expect(router.state.location.pathname).toBe('/days');
    });

    it('offline creates nothing and says so', async () => {
      onOct27();
      stubApi({
        ...fourDates,
        ...october,
        'POST /api/diaries': () => Promise.reject(new TypeError('Failed to fetch')),
      });
      const { router } = renderAt('/days');
      fireEvent.click(await screen.findByRole('button', { name: '补写…' }));
      fireEvent.click(await day('10 月 20 日'));
      expect((await screen.findByRole('alert')).textContent).toBe('离线时无法创建，请联网后再试');
      expect(router.state.location.pathname).toBe('/days');
    });

    it('narrow: sits beside 日期 and opens the day as its own page', async () => {
      onOct27();
      narrowWindow();
      stubApi({
        ...fourDates,
        ...october,
        ...emptyDay('2026-10-20'),
        'GET /api/days?before=2026-10-21': page([]),
        'GET /api/days?after=2026-10-20': page([]),
        'POST /api/diaries': () => Response.json({ created: true, ...openedOn('2026-10-20') }),
      });
      const { router } = renderAt('/days');
      fireEvent.click(await screen.findByRole('button', { name: '补写…' }));
      fireEvent.click(await day('10 月 20 日'));
      await waitFor(() => expect(router.state.location.pathname).toBe('/days/2026-10-20'));
      expect(router.state.location.state).toMatchObject({ edit: true });
    });
  });

  it('[adr:book-frontend-workspace#4] a jump to a day without the own diary creates nothing, and its 写这天 opens it for writing', async () => {
    const opened = vi.fn(() =>
      Response.json({
        created: true,
        diary: {
          diaryId: id(5),
          diaryDate: '2026-10-22',
          ownerId: ME,
          generationId: GENERATION,
          seq: 0,
          ...stateOf([]),
        },
      }),
    );
    const fetchMock = stubApi({
      ...fourDates,
      'GET /api/days?before=2026-10-23': page([]),
      'GET /api/days?after=2026-10-22': page(DATES.map((date, i) => dated(date, i + 1))),
      ...emptyDay('2026-10-22'),
      'POST /api/diaries': opened,
    });
    const { router } = renderAt('/days');
    const region = await feed();
    await waitFor(() => expect(dateOf(region, '2026-10-27')).not.toBeNull());
    fireEvent.change(within(region).getByLabelText('跳到日期'), {
      target: { value: '2026-10-22' },
    });
    fireEvent.click(within(region).getByText('跳转'));
    await waitFor(() => expect(dateOf(region, '2026-10-22')).not.toBeNull());
    const row = dateOf(region, '2026-10-22');
    expect(within(row).queryByRole('link', { name: '编辑' })).toBeNull();
    // Dates the caller wrote on keep 编辑.
    expect(within(dateOf(region, '2026-10-24')).getByRole('link', { name: '编辑' })).toBeDefined();
    expect(requested(fetchMock)).not.toContain('POST /api/diaries');

    fireEvent.click(within(row).getByRole('button', { name: '写这天' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/days/2026-10-22'));
    expect(router.state.location.state).toMatchObject({ edit: true, back: true });
    const [init] = opened.mock.calls[0] as unknown as [RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({ date: '2026-10-22' });
  });

  it('[adr:read-marks-until-leaving#1] [adr:read-marks-until-leaving#3] [adr:read-marks-until-leaving#4] keeps text read in the feed light on its day and back, until the diary page is left', async () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal('navigator', { locks: stubLocks() });
    // The feed's box is the window's top 600px and the partner's text lies inside it; the
    // day is not laid out, so nothing is read there.
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      if (this.classList.contains('day-feed-scroll')) return new DOMRect(0, 0, 300, 600);
      if (this.hasAttribute('data-other')) return new DOMRect(0, 100, 300, 20);
      return new DOMRect(0, 0, 0, 0);
    });
    const shared = { diaryId: id(9), epochId: id(10), share: 'live' as const };
    const theirs: Day = {
      diaryDate: '2026-10-27',
      mine: null,
      partner: { ...dated('2026-10-27', 9).mine!, ...shared, unread: true },
    };
    let read: unknown[] = [];
    stubApi({
      'GET /api/me': signedIn('alice'),
      'GET /api/spaces': () => Response.json({ spaces: [space()] }),
      'GET /api/days': page([theirs, dated('2026-10-26', 1)]),
      ...ownDiary(1, '2026-10-26'),
      ...emptyDay('2026-10-26'),
      'GET /api/days/2026-10-27': () => Response.json({ day: theirs, google: NO_COPY }),
      [`GET /api/diaries/${id(9)}/shares/${id(10)}`]: () =>
        Response.json({
          diary: {
            diaryDate: '2026-10-27',
            ownerId: PARTNER,
            ...shared,
            generationId: GENERATION,
            seq: 0,
            ...stateOf([[2, PARTNER, '新的字']]),
          },
        }),
      [`GET /api/diaries/${id(9)}/read`]: () => Response.json({ ranges: read }),
      [`POST /api/diaries/${id(9)}/read`]: (init) => {
        read = JSON.parse(String(init!.body)).ranges;
        return Response.json({ ranges: read });
      },
      'GET /api/days?before=2026-10-28': page([theirs, dated('2026-10-26', 1)]),
      'GET /api/days?after=2026-10-27': page([]),
    });
    const { router } = renderAt('/days');
    const region = await feed();
    const inFeed = () => within(region).getByText('新的字');
    await waitFor(() => expect(inFeed().className).toContain('day-text-unread'));
    await waitFor(() => expect(inFeed().className).toContain('day-text-kept'), {
      timeout: 4000,
    });

    // On its day: light, and nothing says there is anything new.
    choose(region, '2026-10-27');
    const kept = async () => {
      const editor = await screen.findByRole('textbox');
      await waitFor(() =>
        expect(editor.querySelector('.day-text-kept')?.textContent).toBe('新的字'),
      );
      expect(editor.querySelector('.day-text-unread')).toBeNull();
    };
    await kept();
    expect(screen.queryByText(/处新内容/)).toBeNull();
    expect(screen.queryByRole('button', { name: '下一处未读' })).toBeNull();

    // Another date and back, then the feed again: still light.
    fireEvent.click(within(await index()).getByRole('link', { name: /10 月 26 日/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/days/2026-10-26'));
    fireEvent.click(within(await index()).getByRole('link', { name: /10 月 27 日/ }));
    await kept();
    fireEvent.click(screen.getByRole('link', { name: '连续读' }));
    const back = await feed();
    await waitFor(() =>
      expect(within(back).getByText('新的字').className).toContain('day-text-kept'),
    );

    // Leaving the diary page ends the visit: the read text is plain when it comes back.
    await act(() => router.navigate('/clocks'));
    await act(() => router.navigate('/days'));
    const again = await feed();
    await waitFor(() => expect(within(again).getByText('新的字').tagName).toBe('SPAN'));
    expect(again.querySelector('mark')).toBeNull();
  });

  it('sends an address that is not a date to the feed', async () => {
    stubApi(fourDates);
    const { router } = renderAt('/days/yesterday');
    await waitFor(() => expect(router.state.location.pathname).toBe('/days'));
    expect(await feed()).toBeDefined();
  });
});
