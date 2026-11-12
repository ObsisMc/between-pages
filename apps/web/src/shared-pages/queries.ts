import { useQuery } from '@tanstack/react-query';
import type { ResponseOf } from '@between-pages/contracts';
import { callApi } from '../api/client.ts';

// Shared pages state (shared-pages ADR) in TanStack Query. The text is not here: it is a
// diary session's (D7). A page's own query refreshes while it is open, so what the partner
// writes meanwhile is reported as seen (D5).

export const sharedPagesKey = ['shared-pages'] as const;
export type SharedPagesView = ResponseOf<'sharedPages'>;
export type SharedPageView = ResponseOf<'sharedPage'>;
export const SEEN_REFRESH_MS = 30_000;

export const pageTitle = (title: string) => title || '未命名页面';

export const useSharedPages = () =>
  useQuery({
    queryKey: sharedPagesKey,
    queryFn: () => callApi('sharedPages'),
    refetchInterval: 60_000,
  });

export const useSharedPage = (pageId: string) =>
  useQuery({
    queryKey: [...sharedPagesKey, pageId],
    queryFn: () => callApi('sharedPage', { params: { pageId } }),
    refetchInterval: SEEN_REFRESH_MS,
    retry: false,
  });
