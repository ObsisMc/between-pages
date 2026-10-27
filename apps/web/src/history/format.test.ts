import { describe, expect, it } from 'vitest';
import { countdownLabel } from './format.ts';

describe('countdownLabel', () => {
  it('rounds up to whole seconds and drops zero parts', () => {
    expect(countdownLabel(39_001)).toBe('40 秒');
    expect(countdownLabel(100_000)).toBe('1 分 40 秒');
    expect(countdownLabel(120_000)).toBe('2 分钟');
  });
});
