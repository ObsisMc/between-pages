import { cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stubApi } from '../../test/render.tsx';
import { SharedDiaryList } from './index.ts';

const SPACE = '2b0c1a9e-1111-4a2b-8c3d-4e5f6a7b8c9d';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const card = (n: number, diaryDate: string, share: 'live' | 'frozen', excerpt: string) => ({
  diaryId: id(n),
  diaryDate,
  ownerId: id(9),
  epochId: id(100 + n),
  share,
  excerpt,
  updatedAt: '2026-10-27T08:00:00.000Z',
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('SharedDiaryList', () => {
  it('[adr:diary-collaboration-kernel#11] lists the partner’s shared diaries, marks frozen ones and opens each one’s date', async () => {
    stubApi({
      [`GET /api/spaces/${SPACE}/shared-diaries`]: () =>
        Response.json({
          diaries: [card(1, '2026-10-27', 'live', '今天'), card(2, '2026-10-20', 'frozen', '那天')],
          nextBefore: null,
        }),
    });
    const router = createMemoryRouter(
      [{ path: '/', element: <SharedDiaryList spaceId={SPACE} partner="bob" /> }],
      { initialEntries: ['/'] },
    );
    render(<RouterProvider router={router} />);

    const links = await screen.findAllByRole('link');
    expect(screen.getByRole('heading').textContent).toBe('bob 共享的日记');
    expect(links.map((l) => l.getAttribute('href'))).toEqual([
      '/days/2026-10-27',
      '/days/2026-10-20',
    ]);
    expect(links[0]!.textContent).not.toContain('已停止共享');
    expect(links[1]!.textContent).toContain('已停止共享');
  });
});
