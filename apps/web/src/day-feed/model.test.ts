import { describe, expect, it } from 'vitest';
import type { Day } from '@between-pages/contracts';
import {
  addDays,
  collapseOf,
  diariesOf,
  fromNewest,
  jumpedTo,
  needsText,
  refreshQuery,
  refreshed,
  withNewer,
  withOlder,
  type FeedWindow,
} from './model.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const own = (updatedAt = '2026-10-27T08:00:00Z', writing = false) => ({
  diaryId: id(1),
  excerpt: '',
  updatedAt,
  hasText: true,
  unread: false,
  sharedWithPartner: false,
  writing,
});
const day = (diaryDate: string): Day => ({ diaryDate, mine: own(), partner: null });
const page = (dates: string[], more: { nextBefore?: string; nextAfter?: string } = {}) => ({
  days: dates.map(day),
  nextBefore: more.nextBefore ?? null,
  nextAfter: more.nextAfter ?? null,
});
const dates = (window: FeedWindow) => window.entries.map((e) => (e.day ? e.date : `(${e.date})`));

describe('addDays', () => {
  it('moves across month and year ends', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('the window of dates', () => {
  it('[adr:book-frontend-workspace#4] jumps to a date with no diary, shows it empty and continues both ways', () => {
    // before=2026-06-11 gives the date and older; after=2026-06-10 the nearest newer page.
    let window = jumpedTo(
      '2026-06-10',
      page(['2026-06-08', '2026-06-01'], { nextBefore: '2026-06-01' }),
      page(['2026-06-20', '2026-06-12'], { nextAfter: '2026-06-20' }),
    );
    expect(dates(window)).toEqual([
      '2026-06-20',
      '2026-06-12',
      '(2026-06-10)',
      '2026-06-08',
      '2026-06-01',
    ]);
    expect(window).toMatchObject({ nextAfter: '2026-06-20', nextBefore: '2026-06-01' });

    window = withNewer(window, page(['2026-07-01', '2026-06-20']));
    window = withOlder(window, page(['2026-05-30']));
    expect(dates(window)).toEqual([
      '2026-07-01',
      '2026-06-20',
      '2026-06-12',
      '(2026-06-10)',
      '2026-06-08',
      '2026-06-01',
      '2026-05-30',
    ]);
    expect(window).toMatchObject({ nextAfter: null, nextBefore: null });
  });

  it('[adr:book-frontend-workspace#4] shows a jumped-to date that has a diary once, not as empty', () => {
    const window = jumpedTo('2026-06-10', page(['2026-06-10', '2026-06-01']), page([]));
    expect(dates(window)).toEqual(['2026-06-10', '2026-06-01']);
    expect(window).toMatchObject({ nextAfter: null, nextBefore: null });
  });

  it('refreshes from the newest only while the window reaches it and its top is near', () => {
    const top = fromNewest(page(['2026-10-27', '2026-10-20'], { nextBefore: '2026-10-20' }));
    expect(refreshQuery(top, '2026-10-27')).toEqual({});
    expect(refreshQuery(top, '2026-10-20')).toEqual({ before: '2026-10-21' });
    const jumped = { ...top, nextAfter: '2026-10-27' };
    expect(refreshQuery(jumped, '2026-10-27')).toEqual({ before: '2026-10-28' });
  });

  it('takes a refreshed page for every date it covers and keeps the rest', () => {
    const window: FeedWindow = {
      entries: [
        { date: '2026-10-27', day: day('2026-10-27') },
        { date: '2026-10-25', day: day('2026-10-25') },
        { date: '2026-10-24', day: null },
        { date: '2026-10-20', day: day('2026-10-20') },
        { date: '2026-10-10', day: day('2026-10-10') },
      ],
      nextAfter: '2026-10-27',
      nextBefore: '2026-10-10',
    };
    // From 10-25 down to 10-20: 10-25 is gone, 10-22 is new, the empty 10-24 stays.
    const changed = refreshed(
      window,
      { before: '2026-10-26' },
      page(['2026-10-22', '2026-10-20'], { nextBefore: '2026-10-20' }),
    );
    expect(dates(changed)).toEqual([
      '2026-10-27',
      '(2026-10-24)',
      '2026-10-22',
      '2026-10-20',
      '2026-10-10',
    ]);
    expect(changed).toMatchObject({ nextAfter: '2026-10-27', nextBefore: '2026-10-10' });

    // A page reaching past the oldest date loaded becomes the window's lower end.
    const longer = refreshed(
      window,
      { before: '2026-10-11' },
      page(['2026-10-10', '2026-10-05'], { nextBefore: '2026-10-05' }),
    );
    expect(dates(longer).slice(-2)).toEqual(['2026-10-10', '2026-10-05']);
    expect(longer.nextBefore).toBe('2026-10-05');
  });
});

describe('a diary on the list', () => {
  const partnerDay = (writing: boolean, share: 'live' | 'frozen' = 'live'): Day => ({
    diaryDate: '2026-10-27',
    mine: own('2026-10-27T08:00:00Z', writing),
    partner: {
      diaryId: id(2),
      epochId: id(3),
      share,
      excerpt: '',
      updatedAt: '2026-10-27T09:00:00Z',
      hasText: true,
      unread: true,
      writing,
    },
  });

  it('[adr:book-frontend-workspace#9] collapses any diary being written', () => {
    const [mine, theirs] = diariesOf(partnerDay(false));
    expect(collapseOf(mine!)).toBeNull();
    expect(collapseOf(theirs!)).toBeNull();
    const [mineWriting, theirsWriting] = diariesOf(partnerDay(true));
    expect(collapseOf(mineWriting!)).toBe('writing-self');
    expect(collapseOf(theirsWriting!)).toBe('writing-partner');
  });

  it('reads text again when the list says it changed, except a share read once frozen', () => {
    const [, live] = diariesOf(partnerDay(false));
    const [, frozen] = diariesOf(partnerDay(false, 'frozen'));
    expect(frozen).toMatchObject({ frozen: true, epochId: id(3) });
    expect(needsText(live!, null)).toBe(true);
    expect(needsText(live!, { updatedAt: live!.updatedAt, frozen: false })).toBe(false);
    expect(needsText(live!, { updatedAt: '2026-10-27T08:59:00Z', frozen: false })).toBe(true);
    expect(needsText(frozen!, { updatedAt: '2026-10-27T08:59:00Z', frozen: true })).toBe(false);
  });
});
