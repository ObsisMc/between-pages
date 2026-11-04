import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { callApi } from '../api/client.ts';
import { DraftList } from '../diary/index.ts';
import { Page, PageHeader } from '../shell/index.ts';
import {
  ReadOnlyNotice,
  UnreadLabel,
  dayText,
  refusalText,
  spaceUnreadKey,
  useRequestId,
  useSeen,
  useSeenReporter,
  type SeenTarget,
} from '../space-common/index.ts';
import { Button } from '../ui/index.ts';
import { useLeftDrafts } from './left-drafts.ts';
import { pageTitle, sharedPagesKey, useSharedPages, type SharedPagesView } from './queries.ts';

// The list of shared pages (shared-pages D1): flat, the last updated first, with a dot on
// what the partner changed. Deletion notes come first (D3).

const alertClass = 'mt-3 rounded-xl bg-notice px-4 py-3 text-sm text-ink';

function Note({
  note,
  view,
  report,
}: {
  note: SharedPagesView['notes'][number];
  view: SharedPagesView;
  report: (t: SeenTarget) => void;
}) {
  const ref = useSeen(
    note.unread ? { type: 'shared_page', id: note.id, mark: note.mark } : null,
    report,
  );
  return (
    <li ref={ref} className="rounded-xl bg-accent px-4 py-3 text-sm">
      {view.partner.displayName} 删了"{pageTitle(note.title)}"（
      {note.wrote ? '你写过' : '你改过标题'}
      ）· {dayText(note.deleted.at)} <UnreadLabel unread={note.unread ? 'new' : null} />
    </li>
  );
}

function NewPage() {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [requestId, renew] = useRequestId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const { page } = await callApi('createSharedPage', { body: { requestId, title: '' } });
      renew();
      await client.invalidateQueries({ queryKey: sharedPagesKey });
      await navigate(`/shared-pages/${page.id}`);
    } catch (failure) {
      setError(refusalText(failure));
      await client.invalidateQueries({ queryKey: sharedPagesKey });
      await client.invalidateQueries({ queryKey: spaceUnreadKey });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button type="button" disabled={busy} onClick={() => void create()}>
        新建一页
      </Button>
      {error && (
        <p className={alertClass} role="alert">
          {error}
        </p>
      )}
    </>
  );
}

export function SharedPagesPage() {
  const pages = useSharedPages();
  const report = useSeenReporter(sharedPagesKey);
  const view = pages.data;
  const left = useLeftDrafts(
    view?.me.id,
    view?.pages.map((p) => p.id),
  );
  if (pages.isError)
    return (
      <Page>
        <p className={alertClass} role="alert">
          打不开共享页面，请稍后再试
        </p>
        <Link to="/" className="mt-4 inline-block text-sm text-ink-soft underline">
          回到首页
        </Link>
      </Page>
    );
  if (!view) return <Page className="text-ink-soft">正在打开…</Page>;
  return (
    <Page>
      <PageHeader
        title="共享页面"
        description="随时新建一页，一起写计划、清单和随手记。"
        actions={!view.readOnly && <NewPage />}
      />
      {view.readOnly && <ReadOnlyNotice />}
      {view.notes.length > 0 && (
        <ul className="mb-6 grid gap-2">
          {view.notes.map((n) => (
            <Note key={n.id} note={n} view={view} report={report} />
          ))}
        </ul>
      )}
      {left.drafts.length > 0 && (
        <section className="mb-6" aria-label="已删除页面里没保存的内容">
          <p className="text-sm text-ink-soft">
            这些内容写在已被删除的页面里，没有保存，可以复制。
          </p>
          <DraftList drafts={left.drafts} onDelete={(ids) => void left.remove(ids)} />
        </section>
      )}
      {view.pages.length ? (
        <ul className="grid gap-2">
          {view.pages.map((p) => (
            <li key={p.id} className="shared-page">
              <Link
                to={`/shared-pages/${p.id}`}
                className="flex flex-wrap items-baseline justify-between gap-3 rounded-xl border border-line px-4 py-3 hover:bg-accent"
              >
                <span className="font-serif text-lg">
                  {pageTitle(p.title)} <UnreadLabel unread={p.unread} />
                </span>
                <span className="text-sm text-ink-soft">{dayText(p.updatedAt)}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-ink-soft">还没有页面</p>
      )}
    </Page>
  );
}
