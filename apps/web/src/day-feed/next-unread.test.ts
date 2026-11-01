import { describe, expect, it } from 'vitest';
import type { FeedWindow } from './model.ts';
import { landing, nextUnread, type Answer, type Ask, type Spot } from './next-unread.ts';

/** A window of `dates` (newest first), with more beyond either end when asked. */
const window = (dates: string[], more: { newer?: boolean; older?: boolean } = {}): FeedWindow => ({
  entries: dates.map((date) => ({ date, day: null })),
  nextAfter: more.newer ? dates[0]! : null,
  nextBefore: more.older ? dates.at(-1)! : null,
});
const spot = (date: string, place: Spot['place'], settled = true): Spot => ({
  date,
  place,
  settled,
});
const unknown = () => undefined;
const answers =
  (known: Record<string, Answer>) =>
  (ask: Ask): Answer | undefined =>
    known[JSON.stringify(ask)];

const WINDOW = window(['2026-10-27', '2026-10-26', '2026-10-25'], { newer: true, older: true });

describe('nextUnread', () => {
  it('[adr:book-frontend-workspace#5] goes to the nearest loaded unread in each direction without asking', () => {
    const spots = [
      spot('2026-10-27', 'above'),
      spot('2026-10-26', 'above'),
      spot('2026-10-26', 'above'),
      spot('2026-10-26', 'inside'),
      spot('2026-10-25', 'below'),
      spot('2026-10-25', 'below'),
    ];
    // ↓ the first one below; ↑ the nearest date above, at its first unread passage.
    expect(nextUnread('older', spots, WINDOW, unknown)).toEqual({ next: { spot: 4 }, ask: null });
    expect(nextUnread('newer', spots, WINDOW, unknown)).toEqual({ next: { spot: 1 }, ask: null });
  });

  it('counts a diary the list marks unread, loading or collapsed, as a loaded hit', () => {
    const spots = [spot('2026-10-26', 'inside'), spot('2026-10-25', 'below', false)];
    expect(nextUnread('older', spots, WINDOW, unknown).next).toEqual({ spot: 1 });
  });

  it('asks the server from the loaded range’s end when nothing loaded qualifies', () => {
    const spots = [spot('2026-10-26', 'inside')];
    expect(nextUnread('older', spots, WINDOW, unknown)).toEqual({
      next: null,
      ask: { before: '2026-10-25' },
    });
    expect(nextUnread('newer', spots, WINDOW, unknown)).toEqual({
      next: null,
      ask: { after: '2026-10-27' },
    });
    const known = answers({
      '{"before":"2026-10-25"}': { date: '2026-06-01' },
      '{"after":"2026-10-27"}': { date: '2026-10-30' },
    });
    expect(nextUnread('older', spots, WINDOW, known).next).toEqual({ date: '2026-06-01' });
    expect(nextUnread('newer', spots, WINDOW, known).next).toEqual({ date: '2026-10-30' });
  });

  it('has no button when the server says none, and never wraps around', () => {
    const known = answers({ '{"before":"2026-10-25"}': { date: null } });
    // Unread above does not make ↓ go back up.
    const spots = [spot('2026-10-27', 'above')];
    expect(nextUnread('older', spots, WINDOW, known)).toEqual({
      next: null,
      ask: { before: '2026-10-25' },
    });
  });

  it('has no button when the lookup failed', () => {
    const known = answers({ '{"after":"2026-10-27"}': 'failed' });
    expect(nextUnread('newer', [], WINDOW, known).next).toBeNull();
  });

  it('asks nothing when the window reaches that end', () => {
    const ends = window(['2026-10-27', '2026-10-26']);
    expect(nextUnread('older', [], ends, unknown)).toEqual({ next: null, ask: null });
    expect(nextUnread('newer', [], ends, unknown)).toEqual({ next: null, ask: null });
    expect(nextUnread('older', [], null, unknown)).toEqual({ next: null, ask: null });
    expect(nextUnread('older', [], window([], { older: true }), unknown).ask).toBeNull();
  });
});

describe('landing', () => {
  it('lands on the date’s first spot once it is settled', () => {
    const loading = [spot('2026-10-27', 'above'), spot('2026-06-01', 'inside', false)];
    expect(landing('2026-06-01', loading)).toBe('wait');
    const loaded = [spot('2026-06-01', 'inside'), spot('2026-06-01', 'below')];
    expect(landing('2026-06-01', loaded)).toBe(0);
    expect(landing('2026-06-01', [spot('2026-10-27', 'above')])).toBeNull();
  });
});
