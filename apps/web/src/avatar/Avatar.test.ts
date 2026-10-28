import { describe, expect, it } from 'vitest';
import { initialOf } from './index.ts';

describe('initialOf', () => {
  it('takes the first character of a name, upper-casing Latin letters', () => {
    expect(initialOf('小明')).toBe('小');
    expect(initialOf('alice')).toBe('A');
    expect(initialOf('  émile')).toBe('É');
  });

  it('keeps an emoji or a combined letter whole, and marks a blank name', () => {
    expect(initialOf('👩‍👩‍👧 family')).toBe('👩‍👩‍👧');
    expect(initialOf('éva')).toBe('É');
    expect(initialOf('   ')).toBe('?');
  });
});
