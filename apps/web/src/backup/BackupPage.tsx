import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ResponseOf } from '@between-pages/contracts';
import { Cloud, ExternalLink, Info, RefreshCw, Server } from 'lucide-react';
import { ApiError, callApi } from '../api/client.ts';
import { Page, PageHeader, SectionTitle } from '../shell/index.ts';
import { Button, Popover, PopoverContent, PopoverTrigger } from '../ui/index.ts';

// The backup page (server-backup-and-google-docs D9): the caller's own Google Drive
// connection and the problems worth knowing. Nothing here is visible to the partner. What
// needs the person stays in sight; nothing is folded away (digital-paper-interface D3).

type Backup = ResponseOf<'backup'>['backup'];

const dateTime = (iso: string) =>
  new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(iso),
  );

type BackupEvent = Backup['events'][number];
type BackupItem = NonNullable<BackupEvent['item']>;
type Progress = NonNullable<Backup['progress']>;

/**
 * A page or summary as the backup page names it (google-copy-beyond-diaries D8): a page by
 * the title the server found, its current one or the one its Doc last got.
 */
const itemText = (item: BackupItem) =>
  item.kind === 'page'
    ? item.title === null
      ? '一个共享页面'
      : `共享页面「${item.title || '未命名页面'}」`
    : { wishes: '心愿单', gifts: '礼物墙', anniversaries: '纪念日' }[item.kind];

/** What an entry is about: a page or summary, else a diary date. */
const subject = (date: string | null, e: BackupEvent) =>
  e.item ? itemText(e.item) : dayText(date ?? '');

const EVENT_TEXT: Record<BackupEvent['kind'], (date: string | null, e: BackupEvent) => string> = {
  doc_replaced: (d, e) => `${subject(d, e)}的 Doc 在 Google 里被改过，已另存一份新的`,
  doc_recreated: (d, e) => `${subject(d, e)}的 Doc 不见了，已重新生成`,
  storage_full: () => 'Google 空间已满，备份暂停',
  revoke_failed: () =>
    '没能通知 Google 收回授权，请到 Google 账号的"第三方访问"里移除 Between Pages',
  reconnect_needed: () => 'Google 授权失效，需要重新连接',
  copy_failing: (d, e) => `${subject(d, e)}的备份开始失败，会自动重试`,
  check_failed: () => '检查 Google 里的文件失败，明天再试',
  account_in_use: (_d, e) =>
    `这个 Google 账号也被另一位用户连接着，你的连接已移除；之前写进 ${e.email} 的副本仍在那个 Drive 里，需要的话请自己删除，再换自己的账号连接`,
};

const ERROR_TEXT: Record<string, string> = {
  GOOGLE_UNAVAILABLE: '这台服务器还没有配置 Google 备份',
  GOOGLE_DISCONNECTING: '上一次连接还在断开中，请稍等片刻再连接',
};

// A diary date is a calendar day, shown as written, in no time zone.
const dayText = (date: string) => {
  const [, month, day] = date.split('-').map(Number);
  return `${month} 月 ${day} 日`;
};

/** The days that failed for one reason, each retried on its own (D9, Ray 2026-10-29). */
function failingOf(progress: Progress, failure: 'unreachable' | 'failed') {
  const days = progress.failing.filter((f) => f.failure === failure).map((f) => f.diaryDate);
  if (!days.length) return null;
  const which = days.map(dayText).join('、');
  return (
    <p role="alert" className={warnClass}>
      {failure === 'unreachable'
        ? `暂时连不上 Google，${days.length} 天正在自动重试：${which}`
        : `有 ${days.length} 天备份失败，正在自动重试：${which}`}
    </p>
  );
}

/** The pages and summaries that failed for one reason (google-copy-beyond-diaries D8). */
function failingItemsOf(progress: Progress, failure: 'unreachable' | 'failed') {
  const items = progress.failingItems.filter((f) => f.failure === failure).map((f) => f.item);
  if (!items.length) return null;
  const which = items.map(itemText).join('、');
  return (
    <p role="alert" className={warnClass}>
      {failure === 'unreachable'
        ? `暂时连不上 Google，正在自动重试：${which}`
        : `备份失败，正在自动重试：${which}`}
    </p>
  );
}

const CATEGORY_TEXT: Record<Progress['categories'][number]['category'], string> = {
  diaries: '日记',
  shared_pages: '共享页面',
  wishes: '心愿单',
  gifts: '礼物墙',
  anniversaries: '纪念日',
};

/** One line per kind: what still waits, else how far its Docs reach (D8). */
function CategoryProgress({ progress }: { progress: Progress }) {
  return (
    <ul aria-label="各类备份进度" className="grid gap-1 text-sm">
      {progress.categories.map((c) => (
        <li key={c.category}>
          <span className="text-ink-soft">{CATEGORY_TEXT[c.category]}：</span>
          {c.waiting > 0 ? (
            c.category === 'diaries' ? (
              `还有 ${c.waiting} 天等待备份`
            ) : (
              `还有 ${c.waiting} 项等待备份`
            )
          ) : c.backedUpTo ? (
            <span className="text-done">已备份到 {dateTime(c.backedUpTo)}</span>
          ) : (
            <span className="text-ink-soft">还没有需要备份的内容</span>
          )}
        </li>
      ))}
    </ul>
  );
}

const warnClass = 'rounded-xl bg-notice px-4 py-3 text-sm text-ink';

export const backupQuery = () => ({
  queryKey: ['backup'],
  queryFn: async () => (await callApi('backup')).backup,
});

export interface BackupPageProps {
  /** Sends the browser to Google's consent page; replaced in tests. */
  goTo?: (url: string) => void;
}

/** How long the mouse may be between the icon and the text before it closes. */
const HOVER_CLOSE_MS = 150;

/**
 * Where the Docs go, behind an information icon beside the section title (F-07, Ray
 * 2026-11-08): the text opens on hover, on keyboard focus and on a tap, since touch has no
 * hover. Focus opens it only when it came from the keyboard: a click or tap focuses the
 * button too, and would otherwise open it and at once toggle it shut.
 */
function WhereDocsGo() {
  const [open, setOpen] = useState(false);
  const closing = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelClose = () => {
    if (closing.current) clearTimeout(closing.current);
    closing.current = null;
  };
  const hoverIn = (pointerType: string) => {
    if (pointerType === 'touch') return;
    cancelClose();
    setOpen(true);
  };
  const hoverOut = (pointerType: string) => {
    if (pointerType === 'touch') return;
    cancelClose();
    closing.current = setTimeout(() => setOpen(false), HOVER_CLOSE_MS);
  };
  // A pointer going down on the button focuses it too; only a focus with no pointer before
  // it came from the keyboard.
  const pointerDown = useRef(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="备份存在哪里"
          className="rounded-full text-ink-soft hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-warm [&_svg]:size-4"
          onPointerEnter={(e) => hoverIn(e.pointerType)}
          onPointerLeave={(e) => hoverOut(e.pointerType)}
          onPointerDown={() => {
            pointerDown.current = true;
          }}
          onFocus={() => {
            if (!pointerDown.current) setOpen(true);
            pointerDown.current = false;
          }}
        >
          <Info aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="text-ink-soft"
        onOpenAutoFocus={(e) => e.preventDefault()}
        // Focus never moved into the text, so nothing is handed back on close; handing it to
        // the button would count as a keyboard focus and open the text again.
        onCloseAutoFocus={(e) => e.preventDefault()}
        onPointerEnter={(e) => hoverIn(e.pointerType)}
        onPointerLeave={(e) => hoverOut(e.pointerType)}
      >
        每天一份 Google Doc，存在你 Drive 的{' '}
        <span className="text-ink">我的云端硬盘 › Between Pages › 年 › 月</span>{' '}
        里；共享页面每页一份、心愿单、礼物墙与纪念日各一份，存在{' '}
        <span className="text-ink">Between Pages › Together</span> 里。可以在 Drive 里移动或改名
        Between Pages 文件夹，备份会跟着它；删掉的话会在根目录重新建一个。
      </PopoverContent>
    </Popover>
  );
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
    <Page>
      <PageHeader title="备份" description="好好保存写下的每一天。" />
      <div className="grid gap-10 md:grid-cols-[1fr_18rem]">
        <div className="grid min-w-0 content-start gap-8">
          <section className="flex gap-4 border-b border-line pb-8">
            <Server aria-hidden="true" className="mt-1 size-5 shrink-0 text-ink-soft" />
            <div>
              <SectionTitle className="mb-2 font-sans text-base">服务器自动备份</SectionTitle>
              <p className="text-sm leading-relaxed text-ink-soft">
                服务器每分钟把数据库加密备份到另一处，你不需要做任何事。下面是你自己 Google Drive
                里的可读副本。
              </p>
            </div>
          </section>
          {backup.isError && (
            <p role="alert" className={warnClass}>
              读取备份状态失败，请稍后再试
            </p>
          )}
          {google && (
            <section aria-label="Google Drive" className="flex gap-4">
              <Cloud aria-hidden="true" className="mt-1 size-5 shrink-0 text-ink-soft" />
              <div className="grid min-w-0 flex-1 gap-3">
                <div className="flex items-center gap-2">
                  <h2 className="font-serif text-xl font-medium">我的 Google 可读副本</h2>
                  {google.state !== 'unavailable' && <WhereDocsGo />}
                </div>
                {google.state === 'unavailable' && (
                  <p className="text-ink-soft">这台服务器还没有配置 Google 备份</p>
                )}
                {google.state !== 'unavailable' && (
                  <p className="text-sm text-ink-soft">
                    共享页面、心愿、礼物墙与纪念日会进你们两人各自的
                    Drive（各自连接后）；在应用里删除，不会从对方 Drive 的版本历史里消失。
                  </p>
                )}
                {google.state === 'disconnected' && (
                  <>
                    <p className="text-ink-soft">未开启 Google 备份</p>
                    <Button
                      type="button"
                      className="justify-self-start"
                      disabled={busy}
                      onClick={() => void connect()}
                    >
                      连接 Google Drive
                    </Button>
                  </>
                )}
                {google.state === 'disconnecting' && (
                  <p
                    role={google.retrying ? 'alert' : undefined}
                    className={google.retrying ? warnClass : 'text-ink-soft'}
                  >
                    {google.retrying
                      ? '正在断开：暂时没能通知 Google 收回授权，正在重试'
                      : '正在断开 Google Drive…'}
                  </p>
                )}
                {google.state === 'reconnect' && (
                  <>
                    <p role="alert" className={warnClass}>
                      需要重新连接 Google（{google.email}）
                    </p>
                    <Button
                      type="button"
                      className="justify-self-start"
                      disabled={busy}
                      onClick={() => void connect()}
                    >
                      重新连接
                    </Button>
                  </>
                )}
                {google.state === 'connected' && (
                  <>
                    <p>已连接 {google.email}</p>
                    {google.expiresAt && (
                      <p className="text-sm text-ink-soft">
                        Google 授权将在 {dateTime(google.expiresAt)} 过期，到时请重新连接
                      </p>
                    )}
                  </>
                )}
                {progress && (
                  <div aria-label="备份进度" role="group" className="grid gap-3">
                    <CategoryProgress progress={progress} />
                    {failingOf(progress, 'unreachable')}
                    {failingOf(progress, 'failed')}
                    {failingItemsOf(progress, 'unreachable')}
                    {failingItemsOf(progress, 'failed')}
                    {backup.data?.attention === 'storage_full' && (
                      <p role="alert" className={warnClass}>
                        Google 空间已满，备份暂停。腾出空间后点"现在备份"继续
                      </p>
                    )}
                    {progress.folderUrl && (
                      <p>
                        <a
                          href={progress.folderUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-sm text-warm underline underline-offset-4 [&_svg]:size-4"
                        >
                          在 Google Drive 打开文件夹
                          <ExternalLink aria-hidden="true" />
                        </a>
                      </p>
                    )}
                  </div>
                )}
                {google.state === 'connected' && (
                  <>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        disabled={busy}
                        onClick={() => void runNow()}
                      >
                        <RefreshCw aria-hidden="true" />
                        现在备份
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => void disconnect()}
                      >
                        断开连接
                      </Button>
                    </div>
                    <p className="text-sm text-ink-soft">
                      断开后停止备份，Drive 里已有的文件都会保留。
                    </p>
                  </>
                )}
              </div>
            </section>
          )}
          {error && (
            <p role="alert" className={warnClass}>
              {error}
            </p>
          )}
          {backup.data && backup.data.events.length > 0 && (
            <section aria-label="备份记录" className="border-t border-line pt-8">
              <SectionTitle>备份记录</SectionTitle>
              <ul className="grid gap-2 text-sm">
                {backup.data.events.map((event) => (
                  <li key={`${event.at}-${event.kind}`}>
                    <span className="text-ink-soft">{dateTime(event.at)}</span> ·{' '}
                    {EVENT_TEXT[event.kind](event.diaryDate, event)}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
        <aside className="grid content-start gap-3 self-start rounded-2xl bg-accent p-6 text-sm leading-relaxed">
          <h2 className="font-serif text-lg font-medium">三个状态，分别确认</h2>
          <p className="text-ink-soft">已保存：文字已经存到服务器。</p>
          <p className="text-ink-soft">已成历史：这段写作已经形成历史版本。</p>
          <p className="text-ink-soft">已备份：对应的历史版本已写入 Google。</p>
          <p className="border-t border-line pt-3 text-ink-soft">
            Google 里的副本是单向更新。在那边修改的文字，不会回到这里。
          </p>
        </aside>
      </div>
    </Page>
  );
}
