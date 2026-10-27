import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stubApi } from '../../test/render.tsx';
import { HistoryPanel } from './HistoryPanel.tsx';
import { HistoryPreview } from './HistoryPreview.tsx';

const DIARY = '7c1d2b8e-3f4a-4b5c-8d6e-9f0a1b2c3d4e';
const ME = '6f1c1d0e-0000-4000-8000-000000000001';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const point = (n: number, committedAt: string) => ({ publicId: id(n), committedAt, authors: [ME] });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderPanel(onSelect = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const panel = (commits: number) => (
    <QueryClientProvider client={client}>
      <HistoryPanel diaryId={DIARY} commits={commits} selected={null} onSelect={onSelect} />
    </QueryClientProvider>
  );
  const { rerender } = render(panel(0));
  return { onSelect, commit: (commits: number) => rerender(panel(commits)) };
}

/** Answers the history request with each page in turn, repeating the last. */
function historyAnswers(...pages: object[]) {
  let served = 0;
  return stubApi({
    [`GET /api/diaries/${DIARY}/history`]: () =>
      Response.json(pages[Math.min(served++, pages.length - 1)]),
  });
}

describe('HistoryPanel', () => {
  it('lists points by local day, newest first, and loads older pages by cursor', async () => {
    stubApi({
      [`GET /api/diaries/${DIARY}/history`]: () =>
        Response.json({
          points: [point(3, '2026-10-27T12:00:00Z'), point(2, '2026-10-27T11:00:00Z')],
          nextCursor: 'opaque-1',
          nextPointInMs: null,
        }),
      [`GET /api/diaries/${DIARY}/history?cursor=opaque-1`]: () =>
        Response.json({
          points: [point(1, '2026-10-20T12:00:00Z')],
          nextCursor: null,
          nextPointInMs: null,
        }),
    });
    const { onSelect } = renderPanel();
    const days = await screen.findAllByRole('heading', { level: 3 });
    expect(days).toHaveLength(1);
    fireEvent.click(screen.getByText('加载更早的版本'));
    await waitFor(() => expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(2));
    expect(screen.queryByText('加载更早的版本')).toBeNull();

    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(3);
    fireEvent.click(buttons[0]!);
    expect(onSelect).toHaveBeenCalledWith(point(3, '2026-10-27T12:00:00Z'));
  });

  it('shows the point of the group being written once it closes, without reopening', async () => {
    historyAnswers(
      { points: [], nextCursor: null, nextPointInMs: 20 },
      { points: [point(1, '2026-10-27T12:00:00Z')], nextCursor: null, nextPointInMs: null },
    );
    renderPanel();
    expect(await screen.findByText('还没有历史版本')).toBeDefined();
    await waitFor(() => expect(screen.getAllByRole('button')).toHaveLength(1), { timeout: 3000 });
  });

  it('asks again when a commit arrives while no group is open', async () => {
    const fetchMock = historyAnswers(
      { points: [], nextCursor: null, nextPointInMs: null },
      { points: [], nextCursor: null, nextPointInMs: 120_000 },
    );
    const { commit } = renderPanel();
    await screen.findByText('还没有历史版本');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    commit(1);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    // The group is open now; joining commits only move its close later.
    commit(2);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('says when there is no history yet', async () => {
    stubApi({
      [`GET /api/diaries/${DIARY}/history`]: () =>
        Response.json({ points: [], nextCursor: null, nextPointInMs: null }),
    });
    renderPanel();
    expect(await screen.findByText('还没有历史版本')).toBeDefined();
  });
});

describe('HistoryPreview', () => {
  it('shows the version read-only, with no way to restore it', async () => {
    stubApi({
      [`GET /api/diaries/${DIARY}/history/${id(1)}`]: () =>
        Response.json({
          publicId: id(1),
          committedAt: '2026-10-27T12:00:00Z',
          runs: [{ author: ME, text: '那天\n下雨' }],
        }),
    });
    const onClose = vi.fn();
    render(
      <HistoryPreview
        diaryId={DIARY}
        publicId={id(1)}
        userId={ME}
        currentChanged={false}
        onClose={onClose}
      />,
    );
    const region = await screen.findByRole('region', { name: '历史版本预览' });
    expect(await screen.findByText(/那天/)).toBeDefined();
    expect(region.textContent).toContain('只读');
    expect(region.querySelector('[contenteditable]')).toBeNull();
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['返回当前正文']);
    fireEvent.click(screen.getByText('返回当前正文'));
    expect(onClose).toHaveBeenCalled();
  });

  it('says a version cannot be read instead of showing another', async () => {
    stubApi({
      [`GET /api/diaries/${DIARY}/history/${id(1)}`]: () =>
        Response.json(
          { error: { code: 'VERSION_UNREADABLE', message: 'Stored state failed its check' } },
          { status: 500 },
        ),
    });
    render(
      <HistoryPreview
        diaryId={DIARY}
        publicId={id(1)}
        userId={ME}
        currentChanged={false}
        onClose={() => {}}
      />,
    );
    expect((await screen.findByRole('alert')).textContent).toBe('这个版本暂时无法读取');
  });
});
