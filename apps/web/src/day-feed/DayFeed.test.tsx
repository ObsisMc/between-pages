import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { Day } from '@between-pages/contracts';
import { stateOf, type Turn } from '../../test/day-text.ts';
import { renderAt, signedIn, stubApi } from '../../test/render.tsx';
import { ME, PARTNER, errorBody, space } from '../../test/relationship.ts';
import { DWELL_MS, createReadMarks } from '../read-tracker/index.ts';
import { DayFeed } from './index.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const own = (n: number, more: Partial<NonNullable<Day['mine']>> = {}) => ({
  diaryId: id(n),
  excerpt: '',
  updatedAt: '2026-10-27T08:00:00Z',
  hasText: true,
  unread: false,
  sharedWithPartner: true,
  writing: false,
  partnerWriting: false,
  ...more,
});
const shared = (n: number, more: Partial<NonNullable<Day['partner']>> = {}) => ({
  diaryId: id(n),
  epochId: id(100 + n),
  share: 'live' as const,
  excerpt: '',
  updatedAt: '2026-10-27T09:00:00Z',
  hasText: true,
  unread: false,
  writing: false,
  partnerWriting: false,
  ...more,
});
const page =
  (days: Day[], more: { nextBefore?: string; nextAfter?: string } = {}) =>
  () =>
    Response.json({ days, nextBefore: more.nextBefore ?? null, nextAfter: more.nextAfter ?? null });

// The caller writes as clientID 1, the partner as 2.
const mineSays = (text: string): Turn => [1, ME, text];
const theySay = (text: string): Turn => [2, PARTNER, text];

/** The own diary `n` as `GET /api/diaries/:id` answers (now, when a function), and its coverage. */
const ownDiary = (n: number, turns: Turn[] | (() => Turn[]), read: unknown[] = []) => ({
  [`GET /api/diaries/${id(n)}`]: () =>
    Response.json({
      diary: {
        diaryId: id(n),
        diaryDate: '2026-10-27',
        ownerId: ME,
        generationId: id(500),
        seq: 1,
        ...stateOf(typeof turns === 'function' ? turns() : turns),
      },
    }),
  [`GET /api/diaries/${id(n)}/read`]: () => Response.json({ ranges: read }),
});
/** The partner's diary `n` shared in epoch 100 + n, and the caller's coverage of it. */
const sharedDiary = (n: number, turns: Turn[], read: unknown[] = []) => ({
  [`GET /api/diaries/${id(n)}/shares/${id(100 + n)}`]: () =>
    Response.json({
      diary: {
        diaryId: id(n),
        diaryDate: '2026-10-27',
        ownerId: PARTNER,
        epochId: id(100 + n),
        share: 'live',
        generationId: id(500),
        seq: 1,
        ...stateOf(turns),
      },
    }),
  [`GET /api/diaries/${id(n)}/read`]: () => Response.json({ ranges: read }),
});

const signedInWithSpace = {
  'GET /api/me': signedIn('alice'),
  'GET /api/spaces': () => Response.json({ spaces: [space()] }),
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const feed = () => screen.findByRole('region', { name: '所有日记' });
const dateOf = (region: HTMLElement, date: string) =>
  region.querySelector<HTMLElement>(`[data-date="${date}"]`)!;
const shownDates = (region: HTMLElement) =>
  [...region.querySelectorAll<HTMLElement>('[data-date]')].map((el) => el.dataset.date);
const requested = (fetchMock: ReturnType<typeof stubApi>) =>
  fetchMock.mock.calls.map(([url, init]) => `${init?.method ?? 'GET'} ${String(url)}`);

const people = {
  me: { id: ME, name: 'alice', slot: 1 as const },
  partner: { id: PARTNER, name: 'bob', slot: 2 as const },
};
/** The feed alone, without the diary page around it. */
const feedAlone = () => [{ path: '/', element: <DayFeed {...people} /> }];

describe('DayFeed', () => {
  it('shows each date’s diaries in full, in author colors, and loads older dates to the end', async () => {
    stubApi({
      ...signedInWithSpace,
      'GET /api/days': page(
        [
          { diaryDate: '2026-10-27', mine: own(1), partner: shared(2) },
          { diaryDate: '2026-10-26', mine: own(3), partner: null },
        ],
        { nextBefore: '2026-10-26' },
      ),
      'GET /api/days?before=2026-10-26': page([
        { diaryDate: '2026-10-20', mine: own(4, { hasText: false }), partner: null },
      ]),
      ...ownDiary(
        1,
        [mineSays('早上下雨'), theySay('我也看到了')],
        [{ clientId: 2, from: 0, to: 5 }],
      ),
      ...sharedDiary(2, [theySay('她的一天')], [{ clientId: 2, from: 0, to: 4 }]),
      ...ownDiary(3, [mineSays('前一天')]),
      ...ownDiary(4, []),
    });
    renderAt('/days');
    const region = await feed();
    await within(region).findByText('她的一天');
    expect(shownDates(region)).toEqual(['2026-10-27', '2026-10-26']);

    const first = dateOf(region, '2026-10-27');
    expect(
      within(first)
        .getAllByRole('img')
        .map((img) => img.getAttribute('aria-label')),
    ).toEqual(['alice', 'bob']);
    // The partner's words in the caller's own diary keep the partner's color.
    expect(within(first).getByText('早上下雨').className).toBe('author-slot-1');
    expect(within(first).getByText('我也看到了').className).toBe('author-slot-2');
    expect(within(first).getByText('她的一天').className).toBe('author-slot-2');

    fireEvent.click(within(region).getByText('加载更早的日记'));
    await within(region).findByText('还没有写字');
    expect(shownDates(region)).toEqual(['2026-10-27', '2026-10-26', '2026-10-20']);
    expect(within(region).getByText('已经是最早的一天')).toBeDefined();
    expect(within(region).queryByText('加载更早的日记')).toBeNull();
  });

  it('keeps a keyboard user’s focus on a load button while its page loads and after', async () => {
    let answer!: () => void;
    const answered = new Promise<void>((resolve) => (answer = resolve));
    stubApi({
      ...signedInWithSpace,
      'GET /api/days': page([{ diaryDate: '2026-10-27', mine: own(1), partner: null }], {
        nextBefore: '2026-10-27',
      }),
      'GET /api/days?before=2026-10-27': () =>
        answered.then(
          page([{ diaryDate: '2026-10-26', mine: own(3), partner: null }], {
            nextBefore: '2026-10-26',
          }),
        ),
      ...ownDiary(1, [mineSays('今天')]),
      ...ownDiary(3, [mineSays('昨天')]),
    });
    renderAt('/days');
    const region = await feed();
    const button = await within(region).findByRole('button', { name: '加载更早的日记' });
    button.focus();
    fireEvent.click(button);
    await within(region).findByRole('button', { name: '正在读取…' });
    expect(document.activeElement).toBe(button);
    answer();
    await within(region).findByText('昨天');
    expect(document.activeElement).toBe(button);
    expect(button.textContent).toBe('加载更早的日记');
  });

  it('[adr:book-frontend-workspace#4] jumps to a date not loaded and without a diary, then pages newer and older', async () => {
    const fetchMock = stubApi({
      ...signedInWithSpace,
      'GET /api/days': page([{ diaryDate: '2026-10-27', mine: own(1), partner: null }], {
        nextBefore: '2026-10-27',
      }),
      'GET /api/days?before=2026-06-11': page(
        [{ diaryDate: '2026-06-08', mine: own(3), partner: null }],
        { nextBefore: '2026-06-08' },
      ),
      'GET /api/days?after=2026-06-10': page(
        [{ diaryDate: '2026-06-20', mine: null, partner: shared(4) }],
        { nextAfter: '2026-06-20' },
      ),
      'GET /api/days?after=2026-06-20': page([
        { diaryDate: '2026-10-27', mine: own(1), partner: null },
        { diaryDate: '2026-07-01', mine: own(5), partner: null },
      ]),
      'GET /api/days?before=2026-06-08': page([
        { diaryDate: '2026-06-01', mine: own(6), partner: null },
      ]),
      ...ownDiary(1, [mineSays('最新')]),
      ...ownDiary(3, [mineSays('六月八日')]),
      ...sharedDiary(4, [theySay('六月二十日')]),
      ...ownDiary(5, [mineSays('七月')]),
      ...ownDiary(6, [mineSays('六月一日')]),
    });
    renderAt('/days');
    const region = await feed();
    await within(region).findByText('最新');

    fireEvent.change(within(region).getByLabelText('跳到日期'), {
      target: { value: '2026-06-10' },
    });
    fireEvent.click(within(region).getByText('跳转'));
    await within(region).findByText('六月二十日');
    expect(shownDates(region)).toEqual(['2026-06-20', '2026-06-10', '2026-06-08']);
    // The empty date says nothing about whether the partner wrote that day.
    expect(within(dateOf(region, '2026-06-10')).getByText('这一天没有可以读的日记')).toBeDefined();

    fireEvent.click(within(region).getByText('加载更新的日记'));
    await within(region).findByText('七月');
    fireEvent.click(within(region).getByText('加载更早的日记'));
    await within(region).findByText('六月一日');
    expect(shownDates(region)).toEqual([
      '2026-10-27',
      '2026-07-01',
      '2026-06-20',
      '2026-06-10',
      '2026-06-08',
      '2026-06-01',
    ]);
    // Paging never walked from the newest to the date, and nothing was created. The date
    // index beside the feed reads the newest page once for itself.
    expect(requested(fetchMock).filter((r) => /^GET \/api\/days(\?|$)/.test(r))).toEqual([
      'GET /api/days',
      'GET /api/days',
      'GET /api/days?before=2026-06-11',
      'GET /api/days?after=2026-06-10',
      'GET /api/days?after=2026-06-20',
      'GET /api/days?before=2026-06-08',
    ]);
    expect(requested(fetchMock).filter((r) => r.startsWith('POST'))).toEqual([]);
  });

  it('[adr:book-frontend-workspace#5] reports only the other person’s text on screen for a second, not prefetched or collapsed text', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const fetchMock = stubApi({
      ...signedInWithSpace,
      'GET /api/days': page([
        { diaryDate: '2026-10-27', mine: own(1), partner: shared(2) },
        { diaryDate: '2026-10-26', mine: null, partner: shared(3) },
        {
          diaryDate: '2026-10-25',
          mine: null,
          partner: shared(5, { writing: true, partnerWriting: true }),
        },
      ]),
      ...ownDiary(1, [mineSays('我写的')]),
      ...sharedDiary(2, [theySay('看得见的字')]),
      ...sharedDiary(3, [theySay('还在下面')]),
      [`POST /api/diaries/${id(2)}/read`]: (init) => Response.json(JSON.parse(String(init!.body))),
    });
    // The feed shows 600px; only the first date is inside it, the next one below.
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      if (this.classList.contains('day-feed-scroll')) return new DOMRect(0, 0, 400, 600);
      if (this.closest('[data-date="2026-10-27"]') && this.hasAttribute('data-client'))
        return new DOMRect(0, 100, 300, 20);
      return new DOMRect(0, 0, 0, 0);
    });
    renderAt('/days');
    const region = await feed();
    await within(region).findByText('还在下面');
    expect(within(region).getByText('TA 正在写')).toBeDefined();

    await act(() => vi.advanceTimersByTimeAsync(DWELL_MS));
    expect(requested(fetchMock).filter((r) => r.startsWith('POST'))).toEqual([]);
    await act(() => vi.advanceTimersByTimeAsync(2 * DWELL_MS));
    const reports = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(reports.map(([url, init]) => [String(url), JSON.parse(String(init!.body))])).toEqual([
      [`/api/diaries/${id(2)}/read`, { ranges: [{ clientId: 2, from: 0, to: 5 }] }],
    ]);
    // The collapsed diary was never read at all.
    expect(requested(fetchMock).some((r) => r.includes(id(5)))).toBe(false);
  });

  it('[adr:book-frontend-workspace#9] collapses the diaries being written, then opens them when written', async () => {
    let writing = true;
    const fetchMock = stubApi({
      ...signedInWithSpace,
      'GET /api/days': () =>
        page([
          {
            diaryDate: '2026-10-27',
            mine: null,
            partner: shared(
              2,
              writing
                ? { writing, partnerWriting: writing }
                : { updatedAt: '2026-10-27T09:05:00Z' },
            ),
          },
          { diaryDate: '2026-10-26', mine: own(3, { writing: true }), partner: null },
        ])(),
      ...sharedDiary(2, [theySay('写完了')]),
    });
    renderAt('/', feedAlone());
    const region = await feed();
    expect(await within(region).findByText('TA 正在写')).toBeDefined();
    expect(within(region).getByText('刚写过，约两分钟后在这里显示')).toBeDefined();
    expect(
      within(region)
        .getAllByRole('link', { name: '打开这一天' })
        .map((a) => a.getAttribute('href')),
    ).toEqual(['/days/2026-10-27', '/days/2026-10-26']);
    // No collapsed text is read, so none can be shown or counted.
    expect(requested(fetchMock).filter((r) => r.startsWith('GET /api/diaries'))).toEqual([]);

    // A history point formed: the next refresh opens the partner's diary with its new text.
    writing = false;
    act(() => void window.dispatchEvent(new Event('focus')));
    await within(region).findByText('写完了');
    expect(within(region).queryByText('TA 正在写')).toBeNull();
    expect(within(region).getByText('刚写过，约两分钟后在这里显示')).toBeDefined();
  });

  it('[adr:book-frontend-workspace#9] refreshes on a focus that comes the moment the first page shows', async () => {
    let writing = true;
    stubApi({
      ...signedInWithSpace,
      'GET /api/days': () =>
        page([
          {
            diaryDate: '2026-10-27',
            mine: null,
            partner: shared(
              2,
              writing
                ? { writing, partnerWriting: writing }
                : { updatedAt: '2026-10-27T09:05:00Z' },
            ),
          },
        ])(),
      ...sharedDiary(2, [theySay('写完了')]),
    });
    renderAt('/', feedAlone());
    const region = await feed();
    // The focus lands in the same task as the render that showed the page, before any
    // effect after it has run; the feed must already count as loaded.
    await waitFor(() => {
      within(region).getByText('TA 正在写');
      writing = false;
      window.dispatchEvent(new Event('focus'));
    });
    await within(region).findByText('写完了');
  });

  it('[adr:unread-and-day-page#2] lights a date’s dot from the loaded text and coverage, not the list, once both are known', async () => {
    stubApi({
      ...signedInWithSpace,
      'GET /api/days': page([
        // The list counts only settled history; the partner's newest words are unread here.
        { diaryDate: '2026-10-27', mine: null, partner: shared(2, { unread: false }) },
        { diaryDate: '2026-10-26', mine: null, partner: shared(3, { unread: true }) },
      ]),
      ...sharedDiary(2, [theySay('读过的'), theySay('新写的')], [{ clientId: 2, from: 0, to: 3 }]),
      ...sharedDiary(3, [theySay('都读完了')], [{ clientId: 2, from: 0, to: 4 }]),
    });
    renderAt('/days');
    const region = await feed();
    const fresh = dateOf(region, '2026-10-27');
    await waitFor(() => expect(within(fresh).queryByLabelText('有新内容')).not.toBeNull());
    expect(fresh.querySelector('mark')?.textContent).toBe('新写的');
    const old = dateOf(region, '2026-10-26');
    await within(old).findByText('都读完了');
    await waitFor(() => expect(within(old).queryByLabelText('有新内容')).toBeNull());
  });

  it('keeps the text but no list dots while the list cannot be read, and recovers with 重试', async () => {
    let fail = false;
    stubApi({
      ...signedInWithSpace,
      'GET /api/days': () =>
        fail
          ? errorBody('INTERNAL', 500)()
          : page([
              {
                diaryDate: '2026-10-27',
                mine: own(1),
                partner: shared(2, { unread: true, writing: true, partnerWriting: true }),
              },
            ])(),
      ...ownDiary(1, [mineSays('留在这里')]),
    });
    renderAt('/days');
    const region = await feed();
    await within(region).findByText('留在这里');
    expect(within(region).getByLabelText('有新内容')).toBeDefined();

    fail = true;
    act(() => void window.dispatchEvent(new Event('focus')));
    expect((await within(region).findByRole('alert')).textContent).toBe('日记读取失败，请稍后再试');
    expect(within(region).getByText('留在这里')).toBeDefined();
    expect(within(region).queryByLabelText('有新内容')).toBeNull();

    fail = false;
    fireEvent.click(within(region).getByText('重试'));
    await within(region).findByLabelText('有新内容');
    expect(within(region).queryByRole('alert')).toBeNull();
  });

  it('reads text only near the viewport, and stale text again once it comes near', async () => {
    const observers: { callback: IntersectionObserverCallback; elements: Element[] }[] = [];
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        elements: Element[] = [];
        constructor(callback: IntersectionObserverCallback) {
          observers.push({ callback, elements: this.elements });
        }
        observe(el: Element) {
          this.elements.push(el);
        }
        disconnect() {}
      },
    );
    const near = (...dates: string[]) => {
      const { callback, elements } = observers.at(-1)!;
      act(() =>
        callback(
          elements.map(
            (target) =>
              ({
                target,
                isIntersecting: dates.includes((target as HTMLElement).dataset.date ?? ''),
              }) as IntersectionObserverEntry,
          ),
          {} as IntersectionObserver,
        ),
      );
    };
    let edited = false;
    const fetchMock = stubApi({
      ...signedInWithSpace,
      'GET /api/days': page([
        { diaryDate: '2026-10-27', mine: own(1), partner: null },
        { diaryDate: '2026-10-26', mine: own(3), partner: null },
        { diaryDate: '2026-10-25', mine: own(5), partner: null },
      ]),
      'GET /api/days?before=2026-10-27': page([
        { diaryDate: '2026-10-26', mine: own(3), partner: null },
        {
          diaryDate: '2026-10-25',
          mine: own(5, { updatedAt: '2026-10-27T10:00:00Z' }),
          partner: null,
        },
      ]),
      ...ownDiary(1, [mineSays('最上面')]),
      ...ownDiary(3, [mineSays('中间')]),
      ...ownDiary(5, () => [mineSays(edited ? '改过了' : '远处')]),
    });
    const diaryReads = () =>
      requested(fetchMock).filter((r) => /^GET \/api\/diaries\/[^/]+$/.test(r));
    renderAt('/days');
    const region = await feed();
    await waitFor(() => expect(shownDates(region)).toHaveLength(3));
    expect(diaryReads()).toEqual([]);

    near('2026-10-26');
    await within(region).findByText('中间');
    expect(diaryReads()).toEqual([`GET /api/diaries/${id(3)}`]);
    near('2026-10-25');
    await within(region).findByText('远处');

    // Changed while far: the refresh asks the dates from the newest near one down, and the
    // text is read again only once it comes near.
    near('2026-10-26');
    edited = true;
    act(() => void window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(requested(fetchMock)).toContain('GET /api/days?before=2026-10-27'));
    expect(diaryReads()).toHaveLength(2);
    near('2026-10-25');
    await within(region).findByText('改过了');
    expect(diaryReads()).toEqual([
      `GET /api/diaries/${id(3)}`,
      `GET /api/diaries/${id(5)}`,
      `GET /api/diaries/${id(5)}`,
    ]);
  });
});

describe('DayFeed unread buttons', () => {
  const down = (region: HTMLElement) =>
    within(region).queryByRole('button', { name: '下一处未读' });
  const up = (region: HTMLElement) => within(region).queryByRole('button', { name: '上一处未读' });
  /** The feed's box shows 600px; unread passages lie below it, everything else at 0. */
  const layout = () =>
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      if (this.classList.contains('day-feed-scroll')) return new DOMRect(0, 0, 400, 600);
      if (this.tagName === 'MARK') return new DOMRect(0, 900, 100, 20);
      return new DOMRect(0, 0, 0, 0);
    });

  it('[adr:book-frontend-workspace#5] looks both ways on entry without scrolling or reading, and shows only the way with unread', async () => {
    layout();
    const fetchMock = stubApi({
      ...signedInWithSpace,
      'GET /api/days': page([{ diaryDate: '2026-10-27', mine: null, partner: shared(2) }], {
        nextBefore: '2026-10-27',
      }),
      'GET /api/days/next-unread?before=2026-10-27': () => Response.json({ date: '2026-06-01' }),
      ...sharedDiary(2, [theySay('都读过了')], [{ clientId: 2, from: 0, to: 4 }]),
    });
    renderAt('/days');
    const region = await feed();
    await waitFor(() => expect(down(region)).not.toBeNull());
    // The newest date is loaded: nothing newer to look for, so no ↑ and no ask.
    expect(up(region)).toBeNull();
    expect(requested(fetchMock).filter((r) => r.includes('next-unread'))).toEqual([
      'GET /api/days/next-unread?before=2026-10-27',
    ]);
    // Looking moved nothing and jumped nowhere.
    expect(region.querySelector('.day-feed-scroll')!.scrollTop).toBe(0);
    expect(shownDates(region)).toEqual(['2026-10-27']);
    expect(requested(fetchMock).filter((r) => r.startsWith('POST'))).toEqual([]);
  });

  it('[adr:book-frontend-workspace#5] jumps to an unread date not loaded and its first unread passage, leaving the focus where it was', async () => {
    layout();
    stubApi({
      ...signedInWithSpace,
      'GET /api/days': page([{ diaryDate: '2026-10-27', mine: own(1), partner: null }], {
        nextBefore: '2026-10-27',
      }),
      'GET /api/days/next-unread?before=2026-10-27': () => Response.json({ date: '2026-06-01' }),
      'GET /api/days?before=2026-06-02': page([
        { diaryDate: '2026-06-01', mine: null, partner: shared(3, { unread: true }) },
      ]),
      'GET /api/days?after=2026-06-01': page(
        [{ diaryDate: '2026-10-27', mine: own(1), partner: null }],
        { nextAfter: '2026-10-27' },
      ),
      'GET /api/days/next-unread?after=2026-10-27': () => Response.json({ date: null }),
      ...ownDiary(1, [mineSays('今天')]),
      ...sharedDiary(3, [theySay('读过的'), theySay('没读的')], [{ clientId: 2, from: 0, to: 3 }]),
    });
    renderAt('/', [
      {
        path: '/',
        element: (
          <>
            <textarea aria-label="别处" />
            <DayFeed {...people} />
          </>
        ),
      },
    ]);
    const region = await feed();
    const editor = screen.getByLabelText('别处');
    editor.focus();
    const arrow = await within(region).findByRole('button', { name: '下一处未读' });
    // Pressing the button does not take the focus; the click jumps.
    expect(fireEvent.mouseDown(arrow)).toBe(false);
    fireEvent.click(arrow);

    const passage = await within(region).findByText('没读的');
    await waitFor(() => expect(passage.hasAttribute('data-flash')).toBe(true));
    expect(passage.tagName).toBe('MARK');
    // A third down the 600px box: the passage at 900 moves up by 700.
    expect(region.querySelector('.day-feed-scroll')!.scrollTop).toBe(700);
    expect(document.activeElement).toBe(editor);
  });

  it('[adr:read-marks-until-leaving#1] keeps a jumped-to passage flashing for the whole flash once it is read, then marks it light', async () => {
    // The unread passage lies 900px down the feed's box, so it moves as the box scrolls.
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      const box = document.querySelector('.day-feed-scroll');
      if (this === box) return new DOMRect(0, 0, 400, 600);
      if (this.hasAttribute('data-other') && this.textContent === '没读的')
        return new DOMRect(0, 900 - box!.scrollTop, 100, 20);
      return new DOMRect(0, 0, 0, 0);
    });
    stubApi({
      ...signedInWithSpace,
      'GET /api/days': page([{ diaryDate: '2026-10-27', mine: null, partner: shared(3) }]),
      ...sharedDiary(3, [theySay('读过的'), theySay('没读的')], [{ clientId: 2, from: 0, to: 3 }]),
      [`POST /api/diaries/${id(3)}/read`]: () =>
        Response.json({ ranges: [{ clientId: 2, from: 0, to: 6 }] }),
    });
    renderAt('/', [{ path: '/', element: <DayFeed {...people} marks={createReadMarks()} /> }]);
    const region = await feed();
    fireEvent.click(await within(region).findByRole('button', { name: '下一处未读' }));
    const flashing = () => region.querySelector('[data-flash]')?.textContent;
    await waitFor(() => expect(flashing()).toBe('没读的'));
    const passage = within(region).getByText('没读的');

    // Two checks a second apart see it and report it; the flash outlives that.
    await waitFor(() => expect(passage.className).toContain('day-text-kept'), {
      timeout: 3 * DWELL_MS,
    });
    expect(passage.isConnected).toBe(true);
    expect(flashing()).toBe('没读的');
    // Kept text is not unread: the round button has nowhere left to go.
    expect(region.querySelector('mark.day-text-unread')).toBeNull();
    await waitFor(() => expect(down(region)).toBeNull());
    await waitFor(() => expect(flashing()).toBeUndefined(), { timeout: 2 * DWELL_MS });
    expect(passage.className).toContain('day-text-kept');
  });

  it('hides a button whose lookup failed, without saying there is no unread, and looks again on refresh', async () => {
    let fail = false;
    const lookup = 'GET /api/days/next-unread?before=2026-10-27';
    const fetchMock = stubApi({
      ...signedInWithSpace,
      'GET /api/days': page([{ diaryDate: '2026-10-27', mine: own(1), partner: null }], {
        nextBefore: '2026-10-27',
      }),
      [lookup]: () => (fail ? errorBody('INTERNAL', 500)() : Response.json({ date: '2026-06-01' })),
      ...ownDiary(1, [mineSays('今天')]),
    });
    const lookups = () => requested(fetchMock).filter((r) => r === lookup).length;
    renderAt('/days');
    const region = await feed();
    await within(region).findByRole('button', { name: '下一处未读' });

    fail = true;
    act(() => void window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(lookups()).toBe(2));
    await waitFor(() => expect(down(region)).toBeNull());
    expect(up(region)).toBeNull();
    expect(within(region).queryByText(/没有未读/)).toBeNull();

    fail = false;
    act(() => void window.dispatchEvent(new Event('focus')));
    await within(region).findByRole('button', { name: '下一处未读' });
    expect(lookups()).toBe(3);
  });
});
