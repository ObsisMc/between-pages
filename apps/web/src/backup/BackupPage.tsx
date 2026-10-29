import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import type { ResponseOf } from '@between-pages/contracts';
import { ApiError, callApi } from '../api/client.ts';

// The backup page (server-backup-and-google-docs D9): the caller's own Google Drive
// connection and the problems worth knowing. Nothing here is visible to the partner.

type Backup = ResponseOf<'backup'>['backup'];

const dateTime = (iso: string) =>
  new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(iso),
  );

const EVENT_TEXT: Record<Backup['events'][number]['kind'], (date: string | null) => string> = {
  doc_replaced: (d) => `${d} 的 Doc 在 Google 里被改过，已另存一份新的`,
  doc_recreated: (d) => `${d} 的 Doc 不见了，已重新生成`,
  storage_full: () => 'Google 空间已满，备份暂停',
  revoke_failed: () =>
    '没能通知 Google 收回授权，请到 Google 账号的"第三方访问"里移除 Between Pages',
  reconnect_needed: () => 'Google 授权失效，需要重新连接',
};

const ERROR_TEXT: Record<string, string> = {
  GOOGLE_UNAVAILABLE: '这台服务器还没有配置 Google 备份',
  GOOGLE_DISCONNECTING: '上一次连接还在断开中，请稍等片刻再连接',
};

export const backupQuery = () => ({
  queryKey: ['backup'],
  queryFn: async () => (await callApi('backup')).backup,
});

export interface BackupPageProps {
  /** Sends the browser to Google's consent page; replaced in tests. */
  goTo?: (url: string) => void;
}

export function BackupPage({ goTo = (url) => window.location.assign(url) }: BackupPageProps) {
  const backup = useQuery(backupQuery());
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const connect = async () => {
    setError(null);
    setBusy(true);
    try {
      const { url } = await callApi('startGoogleConnection', { body: {} });
      goTo(url);
    } catch (e) {
      setError((e instanceof ApiError && ERROR_TEXT[e.code]) || '没能开始连接，请稍后再试');
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setError(null);
    setBusy(true);
    try {
      queryClient.setQueryData(
        ['backup'],
        (await callApi('disconnectGoogle', { body: {} })).backup,
      );
    } catch {
      setError('断开失败，请稍后再试');
    } finally {
      setBusy(false);
    }
  };

  const runNow = async () => {
    setError(null);
    setBusy(true);
    try {
      queryClient.setQueryData(['backup'], (await callApi('runBackup', { body: {} })).backup);
    } catch {
      setError('没能开始备份，请稍后再试');
    } finally {
      setBusy(false);
    }
  };

  const google = backup.data?.google;
  const progress = backup.data?.progress;
  return (
    <main className="page backup">
      <header>
        <Link to="/">返回</Link>
      </header>
      <h1>备份</h1>
      <p>
        服务器每分钟把数据库加密备份到另一处，你不需要做任何事。下面是你自己 Google Drive
        里的可读副本。
      </p>
      {backup.isError && <p role="alert">读取备份状态失败，请稍后再试</p>}
      {google && (
        <section aria-label="Google Drive">
          {google.state === 'unavailable' && <p>这台服务器还没有配置 Google 备份</p>}
          {google.state === 'disconnected' && (
            <>
              <p>未开启 Google 备份</p>
              <button
                type="button"
                className="primary"
                disabled={busy}
                onClick={() => void connect()}
              >
                连接 Google Drive
              </button>
            </>
          )}
          {google.state === 'disconnecting' && <p>正在断开 Google Drive…</p>}
          {google.state === 'reconnect' && (
            <>
              <p role="alert">需要重新连接 Google（{google.email}）</p>
              <button
                type="button"
                className="primary"
                disabled={busy}
                onClick={() => void connect()}
              >
                重新连接
              </button>
            </>
          )}
          {google.state === 'connected' && (
            <>
              <p>已连接 {google.email}</p>
              {google.expiresAt && (
                <p>Google 授权将在 {dateTime(google.expiresAt)} 过期，到时请重新连接</p>
              )}
              <button type="button" disabled={busy} onClick={() => void runNow()}>
                现在备份
              </button>
              <button type="button" disabled={busy} onClick={() => void disconnect()}>
                断开连接
              </button>
              <p className="hint">断开后停止备份，Drive 里已有的文件都会保留。</p>
            </>
          )}
        </section>
      )}
      {progress && (
        <section aria-label="备份进度">
          {progress.waitingDays > 0 ? (
            <p>还有 {progress.waitingDays} 天等待备份</p>
          ) : progress.backedUpTo ? (
            <p>全部日记已备份到 {dateTime(progress.backedUpTo)} 的版本</p>
          ) : (
            <p>还没有需要备份的日记</p>
          )}
          {progress.retrying && <p>暂时连不上 Google，正在自动重试</p>}
          {backup.data?.attention === 'storage_full' && (
            <p role="alert">Google 空间已满，备份暂停。腾出空间后点"现在备份"继续</p>
          )}
          {progress.folderUrl && (
            <p>
              <a href={progress.folderUrl} target="_blank" rel="noreferrer">
                在 Google Drive 打开文件夹
              </a>
            </p>
          )}
        </section>
      )}
      {error && <p role="alert">{error}</p>}
      {backup.data && backup.data.events.length > 0 && (
        <section aria-label="备份记录">
          <h2>备份记录</h2>
          <ul>
            {backup.data.events.map((event) => (
              <li key={`${event.at}-${event.kind}`}>
                {dateTime(event.at)} · {EVENT_TEXT[event.kind](event.diaryDate)}
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
