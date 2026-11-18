import { useBinding, useSpaces } from '../relationship/index.ts';
import { useBadgeShown } from '../pwa/index.ts';
import { useSpaceUnread } from '../space-common/index.ts';

// Which pages the navigation lists (digital-paper-interface D1, the visibility rules of
// book-frontend-workspace D2): only pages the caller can reach now. The two clocks need a
// current binding; the space, wishes, anniversaries and shared pages need a space, which stays
// readable after unbinding (space-records D5, invariant 10); the partner page, where an
// invitation is made, only while there is no current binding (spaces-and-invitations D12). An
// entry's count is the server's unread count, which never counts the partner's unrevealed
// preparations. 我的名字 is always there, bound or not (display-name D7).

export type SiteEntry = { to: string; label: string; unread?: number | undefined };

export type SiteEntries = {
  /** 「一起」, empty without a space. */
  together: SiteEntry[];
  /** 「设置」. */
  settings: SiteEntry[];
  /** The three features' unread added up, 0 without a space; undefined until known. */
  spaceUnread: number | undefined;
};

export function useSiteEntries(): SiteEntries {
  const binding = useBinding();
  const spaces = useSpaces();
  const current = binding.data?.binding?.space;
  // One fixed partner in the first release, so at most one space, current or archived.
  const archived = spaces.data?.spaces[0];
  const space = current ?? archived;
  const unread = useSpaceUnread(!!space, useBadgeShown()).data?.features;
  const known = binding.data !== undefined && spaces.data !== undefined;
  return {
    spaceUnread: !known
      ? undefined
      : !space
        ? 0
        : unread && unread.wishes + unread.anniversaries + unread.sharedPages,
    together: space
      ? [
          ...(current ? [{ to: '/clocks', label: '两地时间' }] : []),
          { to: '/wishes', label: '心愿与礼物', unread: unread?.wishes },
          { to: '/anniversaries', label: '纪念日', unread: unread?.anniversaries },
          { to: '/shared-pages', label: '共享页面', unread: unread?.sharedPages },
        ]
      : [],
    settings: [
      ...(space ? [{ to: `/spaces/${space.id}`, label: '双人空间' }] : []),
      ...(current ? [] : [{ to: '/partner', label: '搭档' }]),
      { to: '/backup', label: '备份' },
      { to: '/mail', label: '邮件提醒' },
      { to: '/name', label: '我的名字' },
    ],
  };
}
