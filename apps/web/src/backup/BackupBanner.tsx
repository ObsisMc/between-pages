import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { backupQuery } from './BackupPage.tsx';

// The home banner (server-backup-and-google-docs D9): only when the user has to act.
// Google being briefly unreachable is retried on its own and shown on the backup page only.

const dateTime = (iso: string) =>
  new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(iso),
  );

export function BackupBanner() {
  const backup = useQuery(backupQuery()).data;
  if (!backup?.attention) return null;
  const text =
    backup.attention === 'reconnect'
      ? 'Google 备份已暂停：授权失效，需要重新连接'
      : backup.attention === 'storage_full'
        ? 'Google 空间已满，备份暂停：请在 Google Drive 里腾出空间'
        : `Google 授权将在 ${dateTime(backup.google.expiresAt!)} 过期，请重新连接`;
  return (
    <p className="notice backup-banner" role="alert">
      {text} · <Link to="/backup">去备份页</Link>
    </p>
  );
}
