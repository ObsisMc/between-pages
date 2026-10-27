import { describe, expect, it } from 'vitest';
import { normalizeSelection, sameSelection } from './selection.ts';

describe('normalizeSelection', () => {
  it('[adr:spaces-and-invitations#6] sorts and merges overlapping and touching ranges, open ends included', () => {
    expect(
      normalizeSelection({
        include: [
          { from: '2026-10-05', to: '2026-10-09' },
          { from: '2026-10-01', to: '2026-10-04' },
          { from: '2026-10-08', to: '2026-10-12' },
          { from: '2026-12-01', to: null },
          { from: '2026-11-30', to: '2026-11-30' },
          { from: null, to: '2026-01-01' },
          { from: '2025-12-31', to: '2026-01-02' },
        ],
        exclude: [
          { from: '2026-10-07', to: '2026-10-07' },
          { from: '2026-10-07', to: '2026-10-07' },
        ],
      }),
    ).toEqual({
      include: [
        { from: null, to: '2026-01-02' },
        { from: '2026-10-01', to: '2026-10-12' },
        { from: '2026-11-30', to: null },
      ],
      exclude: [{ from: '2026-10-07', to: '2026-10-07' }],
    });
  });

  it('merges across month and leap-day boundaries and keeps one everything range', () => {
    expect(
      normalizeSelection({
        include: [
          { from: '2028-03-01', to: '2028-03-02' },
          { from: '2028-02-20', to: '2028-02-29' },
        ],
        exclude: [],
      }).include,
    ).toEqual([{ from: '2028-02-20', to: '2028-03-02' }]);
    expect(
      normalizeSelection({
        include: [
          { from: '2026-10-01', to: null },
          { from: null, to: null },
        ],
        exclude: [],
      }).include,
    ).toEqual([{ from: null, to: null }]);
  });

  it('[adr:spaces-and-invitations#6] compares selections by the days they name, not their order or split', () => {
    const split = {
      include: [
        { from: '2026-10-03', to: '2026-10-04' },
        { from: '2026-10-01', to: '2026-10-02' },
      ],
      exclude: [],
    };
    const whole = { include: [{ from: '2026-10-01', to: '2026-10-04' }], exclude: [] };

    expect(sameSelection(split, whole)).toBe(true);
    expect(
      sameSelection(whole, { include: [{ from: '2026-10-01', to: '2026-10-05' }], exclude: [] }),
    ).toBe(false);
  });
});
