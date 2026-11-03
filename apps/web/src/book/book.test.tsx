import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderAt } from '../../test/render.tsx';
import { BookSpread } from './index.ts';

const page = (name: string) => <p>{name}的正文</p>;

afterEach(cleanup);

describe('BookSpread', () => {
  it('[adr:book-frontend-workspace#1] keeps each page in its own container', () => {
    renderAt('/', [{ path: '/', element: <BookSpread left={page('左')} right={page('右')} /> }]);
    const left = screen.getByText('左的正文').parentElement!;
    const right = screen.getByText('右的正文').parentElement!;
    expect(left.className).toBe('book-page book-left');
    expect(right.className).toBe('book-page book-right');
    expect(left.contains(right) || right.contains(left)).toBe(false);
  });
});
