import { useMe } from '../auth/me.ts';
import { Page, PageHeader } from '../shell/index.ts';
import { NameForm } from './NameForm.tsx';

/** 设置 → 我的名字 (display-name D7): the caller's own name, the one both people see. */
export function NamePage() {
  const me = useMe();
  if (!me.data) return null;
  return (
    <Page>
      <PageHeader title="我的名字" description="你在这里叫什么，两个人看到的都是同一个。" />
      <div className="grid max-w-2xl gap-4">
        <NameForm current={me.data.user.displayName} />
        <p className="text-sm leading-relaxed text-ink-soft">
          对方会看到这个名字。Google Drive 里的日记 Doc 等那一天下次备份时更新。
        </p>
      </div>
    </Page>
  );
}
