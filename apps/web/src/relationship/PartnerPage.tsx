import { useMe } from '../auth/me.ts';
import { Page, PageHeader } from '../shell/index.ts';
import { RelationshipPanel } from './RelationshipPanel.tsx';

/**
 * 设置 → 搭档 (spaces-and-invitations D12): the whole invitation flow, choosing the range,
 * generating the link, revoking it and restoring the archived space, away from the home.
 */
export function PartnerPage() {
  const me = useMe();
  if (!me.data) return null;
  return (
    <Page>
      <PageHeader
        title="搭档"
        description="首版绑定后搭档固定，不支持更换。每人只共享自己确认过的日期，对方看不到这个设置。"
      />
      <div className="max-w-2xl">
        <RelationshipPanel userId={me.data.user.id} />
      </div>
    </Page>
  );
}
