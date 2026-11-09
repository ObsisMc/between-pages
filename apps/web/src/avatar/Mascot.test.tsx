import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Mascot, type MascotMood } from './Mascot.tsx';

const MOODS: MascotMood[] = ['idle', 'poked', 'happy', 'asleep'];

const bodyFill = (container: HTMLElement) =>
  [...container.querySelectorAll('path')]
    .find((p) => p.getAttribute('fill')?.startsWith('#'))
    ?.getAttribute('fill');

describe('Mascot', () => {
  it('[adr:soft-mascot#3] [adr:soft-mascot#4] is hidden from assistive technology, and only its shadow is filtered', () => {
    for (const mood of MOODS) {
      const { container } = render(<Mascot tone={1} mood={mood} />);
      expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
      const filtered = [...container.querySelectorAll('[filter]')];
      expect(filtered).toHaveLength(1);
      expect(filtered[0]?.tagName).toBe('ellipse');
      expect(filtered[0]?.getAttribute('cy')).toBe('79');
    }
  });

  it('[adr:soft-mascot#5] takes its color from the author slot, whatever its mood', () => {
    const fills = (tone: 1 | 2) =>
      new Set(MOODS.map((mood) => bodyFill(render(<Mascot tone={tone} mood={mood} />).container)));
    expect(fills(1).size).toBe(1);
    expect(fills(2).size).toBe(1);
    expect([...fills(1)]).not.toEqual([...fills(2)]);
  });
});
