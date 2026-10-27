import { describe, expect, it } from 'vitest';
import { DateSelection } from './sharing.ts';

describe('DateSelection', () => {
  it('accepts single days, open ends and exclusions', () => {
    const selection = {
      include: [
        { from: '2026-10-01', to: '2026-10-01' },
        { from: '2026-11-01', to: null },
      ],
      exclude: [{ from: null, to: '2024-02-29' }],
    };

    expect(DateSelection.parse(selection)).toEqual(selection);
  });

  it('rejects a range that ends before it starts, a date that does not exist and extra fields', () => {
    const range = (from: string | null, to: string | null) => ({
      include: [{ from, to }],
      exclude: [],
    });

    expect(DateSelection.safeParse(range('2026-10-02', '2026-10-01')).success).toBe(false);
    expect(DateSelection.safeParse(range('2026-02-30', null)).success).toBe(false);
    expect(DateSelection.safeParse({ ...range(null, null), ownerId: 'x' }).success).toBe(false);
  });
});
