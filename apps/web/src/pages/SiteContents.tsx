import { useMe } from '../auth/me.ts';
import { ContentsBookmark, ContentsPages, type ContentsGroup } from '../book/index.ts';
import { useBinding, useSpaces } from '../relationship/index.ts';
import { EntryDot, useSpaceUnread } from '../space-common/index.ts';
import { localToday } from './today.ts';

// What the 「目录」 lists (book-frontend-workspace D2): only pages the caller can reach now.
// The two clocks need a current binding; the space, wishes and anniversaries need a space,
// which stays readable after unbinding (space-records D5, invariant 10). No diary text and
// nothing about gifts: an entry's dot is the server's unread count, which never counts the
// partner's unrevealed preparations.

function SiteContents() {
  const current = useBinding().data?.binding?.space;
  // One fixed partner in the first release, so at most one space, current or archived.
  const archived = useSpaces().data?.spaces[0];
  const space = current ?? archived;
  const unread = useSpaceUnread(!!space).data?.features;

  const groups: ContentsGroup[] = [
    {
      title: '日记',
      entries: [
        { to: `/days/${localToday()}`, label: '今天的日记' },
        { to: '/days', label: '所有日记' },
      ],
    },
  ];
  if (space)
    groups.push({
      title: '一起',
      entries: [
        ...(current ? [{ to: '/clocks', label: '两地时间' }] : []),
        { to: '/wishes', label: '心愿与礼物', badge: <EntryDot count={unread?.wishes} /> },
        {
          to: '/anniversaries',
          label: '纪念日',
          badge: <EntryDot count={unread?.anniversaries} />,
        },
      ],
    });
  groups.push({
    title: '管理',
    entries: [
      ...(space ? [{ to: `/spaces/${space.id}`, label: '双人空间' }] : []),
      { to: '/backup', label: '备份' },
    ],
  });
  return <ContentsPages groups={groups} />;
}

/** The site-wide bookmark, for a signed-in user; its contents read their data only while open. */
export function SiteBookmark() {
  const me = useMe();
  if (!me.data) return null;
  return (
    <ContentsBookmark>
      <SiteContents />
    </ContentsBookmark>
  );
}
