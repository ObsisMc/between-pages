import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, callApi } from '../api/client.ts';
import { DiaryBlock, usePeople, type GoogleCopy, type PageSource } from '../diary/index.ts';
import { Page } from '../shell/index.ts';
import { COPY_STAYS_NOTE, refusalText, useSeenReporter } from '../space-common/index.ts';
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  DialogTrigger,
  Input,
} from '../ui/index.ts';
import { sharedPagesKey, useSharedPage, useSharedPages, type SharedPageView } from './queries.ts';

// One shared page (shared-pages D2–D5). The text is a diary session; this screen adds the
// title and deletion, which either of the two may do, and clears the page's unread as soon
// as it is open, and again as what the partner writes arrives (D5).

const alertClass = 'mt-3 rounded-xl bg-notice px-4 py-3 text-sm text-ink';

const pageCopy = (google: SharedPageView['google']): GoogleCopy => ({
  connected: google.connected,
  backedUpAt: google.coveredAt,
  docUrl: google.docUrl,
  problem: google.problem,
});

function Title({ view, onChanged }: { view: SharedPageView; onChanged: () => Promise<void> }) {
  const [error, setError] = useState<string | null>(null);
  const rename = async (title: string) => {
    const next = title.trim();
    if (next === view.page.title) return;
    setError(null);
    try {
      await callApi('renameSharedPage', {
        params: { pageId: view.page.id },
        body: {
          requestId: crypto.randomUUID(),
          expectedRevision: view.page.revision,
          title: next,
        },
      });
    } catch (failure) {
      setError(refusalText(failure));
    }
    await onChanged();
  };
  const enter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') event.currentTarget.blur();
  };
  return (
    <div className="min-w-0 flex-1">
      <Input
        // A rename by either person replaces what is shown.
        key={view.page.revision}
        aria-label="页面标题"
        className="font-serif text-xl"
        defaultValue={view.page.title}
        placeholder="未命名页面"
        maxLength={60}
        disabled={view.readOnly}
        onBlur={(event) => void rename(event.currentTarget.value)}
        onKeyDown={enter}
      />
      {error && (
        <p className={alertClass} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function DeletePage({ view, partner }: { view: SharedPageView; partner: string }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [requestId] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<string | null>(null);
  // Who wrote in the page is read again on opening: the partner may have just begun (D3).
  const [checking, setChecking] = useState(false);
  const check = async (open: boolean) => {
    if (!open) return;
    setChecking(true);
    try {
      await client.refetchQueries({ queryKey: [...sharedPagesKey, view.page.id], exact: true });
    } finally {
      setChecking(false);
    }
  };
  const partnerWrote = view.bindings.some((b) => b.userId === partner);
  const remove = async () => {
    setError(null);
    try {
      await callApi('deleteSharedPage', { params: { pageId: view.page.id }, body: { requestId } });
      await client.invalidateQueries({ queryKey: sharedPagesKey, exact: true });
      await navigate('/shared-pages');
    } catch (failure) {
      setError(refusalText(failure));
    }
  };
  return (
    <Dialog onOpenChange={(open) => void check(open)}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline">
          删除
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogTitle>删除这一页？</DialogTitle>
        <p className="text-sm">删除后两人都看不到，也不能恢复。</p>
        {partnerWrote && <p className="text-sm">TA 写的内容也会一起消失。</p>}
        <p className="text-sm">{COPY_STAYS_NOTE}</p>
        {error && (
          <p className={alertClass} role="alert">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <DialogClose asChild>
            <Button type="button" variant="outline">
              取消
            </Button>
          </DialogClose>
          <Button type="button" disabled={checking} onClick={() => void remove()}>
            确认删除
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * How many times what the editor opened under changed: the binding period, or the page
 * being gone. The first value known is the one it opened with, so it counts nothing.
 */
function useReopenCount(context: string | undefined) {
  const [seen, setSeen] = useState({ context, count: 0 });
  if (context !== undefined && context !== seen.context)
    setSeen({ context, count: seen.context === undefined ? seen.count : seen.count + 1 });
  return seen.count;
}

export function SharedPageScreen() {
  const { pageId = '' } = useParams();
  const client = useQueryClient();
  const list = useSharedPages();
  const opened = useSharedPage(pageId);
  const { people, known } = usePeople();
  const report = useSeenReporter(sharedPagesKey);
  const source = useMemo<PageSource>(
    () => ({ load: () => callApi('sharedPage', { params: { pageId } }) }),
    [pageId],
  );

  const gone = opened.error instanceof ApiError && opened.error.code === 'NOT_FOUND';
  const view = gone ? undefined : opened.data;
  // The editor follows the page (D4): unbound or bound again, it opens anew in that period;
  // deleted, the open one ends where it is, so its drafts stay on screen to copy.
  const reopened = useReopenCount(view && (view.periodId ?? 'unbound'));
  const unread = view?.page.unread;
  const mark = view?.page.mark;
  useEffect(() => {
    if (unread && mark !== undefined) report({ type: 'shared_page', id: pageId, mark });
  }, [unread, mark, pageId, report]);

  const me = list.data?.me.id;
  return (
    <Page>
      <Link to="/shared-pages" className="text-sm text-ink-soft underline">
        所有页面
      </Link>
      <h1 className="sr-only">共享页面</h1>
      {view && list.data && (
        <div className="mt-4 mb-6 flex flex-wrap items-start gap-3">
          <Title
            view={view}
            onChanged={() => client.invalidateQueries({ queryKey: sharedPagesKey })}
          />
          {!view.readOnly && <DeletePage view={view} partner={list.data.partner.id} />}
        </div>
      )}
      {me && known ? (
        <DiaryBlock
          key={`${pageId}:${reopened}`}
          userId={me}
          diaryId={pageId}
          page={source}
          people={people}
          closed={gone ? 'NOT_FOUND' : undefined}
          // The page's Doc in the caller's own Drive, as a day's (google-copy-beyond-diaries D8).
          googleCopy={view && pageCopy(view.google)}
          // The editor learned it first: the title, deletion and list follow it now.
          onClosed={() => {
            if (!view?.readOnly) void client.invalidateQueries({ queryKey: sharedPagesKey });
          }}
        />
      ) : list.isError ? (
        // Without the space the page has no writer to open as; say so rather than wait.
        <div className={alertClass} role="alert">
          打不开这一页，请联网后重试。
          <Button
            type="button"
            variant="link"
            className="text-warm underline"
            onClick={() => void list.refetch()}
          >
            重试
          </Button>
        </div>
      ) : (
        <p className="text-ink-soft">正在打开…</p>
      )}
    </Page>
  );
}
