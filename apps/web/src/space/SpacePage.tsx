import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { CalendarRange, ChevronDown, RefreshCw } from 'lucide-react';
import type { DateSelection, ResponseOf } from '@between-pages/contracts';
import { callApi } from '../api/client.ts';
import { useMe } from '../auth/me.ts';
import {
  partnerOf,
  refreshRelationships,
  refusalText,
  relationshipKeys,
} from '../relationship/index.ts';
import { SharedDiaryList } from '../shared-diaries/index.ts';
import { Page, PageHeader, SectionTitle } from '../shell/index.ts';
import { localToday } from '../today/index.ts';
import {
  MonthView,
  NO_DAYS,
  RangeEditor,
  daysOnlyIn,
  describeRanges,
  describeSelection,
  type RangeChoice,
} from '../sharing-range/index.ts';
import {
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../ui/index.ts';

type Mine = ResponseOf<'mySharing'>;

const timeText = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/**
 * What confirming `next` does to the caller's diaries (kernel D5): the days it starts
 * sharing and the days it stops, compared with what is shared now.
 */
function ChangePreview({ now, next }: { now: DateSelection; next: DateSelection }) {
  const opening = daysOnlyIn(next, now);
  const stopping = daysOnlyIn(now, next);
  return (
    <>
      {opening.length > 0 && (
        <p>
          将开放：{describeRanges(opening)}
          。对方会看到这些日期日记的当前正文和以后的编辑，看不到未共享期间的历史；这些日记的撤销记录从开放时重新开始。
        </p>
      )}
      {stopping.length > 0 && (
        <p>
          将停止更新：{describeRanges(stopping)}。对方保留已共享的只读版本，之后的修改不再给对方。
        </p>
      )}
      {opening.length === 0 && stopping.length === 0 && <p>共享的日期没有变化。</p>}
    </>
  );
}

/** The caller's own range: shown always, editable while the space is active (D5, D12). */
function MyRange({
  spaceId,
  periodId,
  mine,
}: {
  spaceId: string;
  periodId: string | null;
  mine: Mine;
}) {
  const client = useQueryClient();
  const [choice, setChoice] = useState<RangeChoice>({
    kind: 'selection',
    selection: mine.selection,
  });
  const [confirming, setConfirming] = useState<DateSelection | null>(null);
  // Kept until an answer arrives, so retrying a lost save returns its first result.
  const [requestId, setRequestId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const confirmedNow = periodId !== null && mine.confirmedPeriodId === periodId;
  // Folded while confirmed for this binding; the editor stays mounted while folded, so a
  // range being chosen survives folding it.
  const [editing, setEditing] = useState(!confirmedNow);

  const save = async (selection: DateSelection) => {
    const id = requestId ?? crypto.randomUUID();
    setRequestId(id);
    setBusy(true);
    setError(null);
    try {
      await callApi('saveMySharing', {
        params: { spaceId },
        body: {
          requestId: id,
          expectedPeriodId: periodId!,
          expectedRevision: mine.revision,
          selection,
        },
      });
      setRequestId(null);
      setConfirming(null);
      setSaved(true);
      await client.invalidateQueries({ queryKey: relationshipKeys.mySharing(spaceId) });
    } catch (e) {
      setError(refusalText(e));
    } finally {
      setBusy(false);
    }
  };

  const alert = error && (
    <p className="rounded-xl bg-notice px-4 py-3 text-sm" role="alert">
      {error}{' '}
      <Button
        type="button"
        variant="link"
        className="text-warm underline"
        onClick={() => {
          setError(null);
          setRequestId(null);
          setConfirming(null);
          void refreshRelationships(client);
        }}
      >
        重新载入
      </Button>
    </p>
  );

  return (
    <section aria-labelledby="my-range-title" className="border-b border-line pb-8">
      <SectionTitle id="my-range-title">我的共享范围</SectionTitle>
      <p className="text-ink">
        {mine.revision === 0 ? '还没有设置过共享范围' : describeSelection(mine.selection)}
        {periodId !== null &&
          (confirmedNow
            ? '（已为本次绑定确认，正在共享）'
            : '（尚未为本次绑定确认，日记没有共享；之前的设置仅供参考）')}
      </p>
      {periodId === null ? (
        <div className="mt-4">
          <MonthView selection={mine.selection} today={localToday()} />
        </div>
      ) : (
        <Collapsible open={editing} onOpenChange={setEditing} className="mt-4">
          <CollapsibleTrigger asChild>
            <Button variant="outline" size="sm" className="group">
              <CalendarRange aria-hidden="true" />
              调整共享日期
              <ChevronDown
                aria-hidden="true"
                className="transition-transform group-data-[state=open]:rotate-180"
              />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent forceMount hidden={!editing} className="mt-4 grid gap-4">
            <RangeEditor
              initial={mine.selection}
              today={localToday()}
              onChange={(c) => {
                setChoice(c);
                setSaved(false);
              }}
            />
            <Button
              type="button"
              className="justify-self-start"
              disabled={choice.kind !== 'selection'}
              onClick={() => choice.kind === 'selection' && setConfirming(choice.selection)}
            >
              保存范围
            </Button>
          </CollapsibleContent>
        </Collapsible>
      )}
      {saved && (
        <p role="status" className="mt-3 text-sm text-done">
          范围已保存
        </p>
      )}
      {!confirming && <div className="mt-3">{alert}</div>}
      <Dialog
        open={confirming !== null}
        onOpenChange={(open) => !open && !busy && (setConfirming(null), setError(null))}
      >
        {confirming && (
          <DialogContent className="max-w-lg">
            <DialogTitle>确认共享范围</DialogTitle>
            <DialogDescription>保存前，先看清哪些日期会开放、哪些会停止更新。</DialogDescription>
            <div className="grid gap-2 text-sm leading-relaxed">
              <p>原来：{mine.revision === 0 ? '未设置' : describeSelection(mine.selection)}</p>
              <p>保存后：{describeSelection(confirming)}</p>
              <ChangePreview now={confirmedNow ? mine.selection : NO_DAYS} next={confirming} />
            </div>
            {alert}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => (setConfirming(null), setError(null))}
              >
                取消
              </Button>
              <Button type="button" disabled={busy} onClick={() => void save(confirming)}>
                {busy ? '正在准备共享…' : '确认保存'}
              </Button>
            </div>
          </DialogContent>
        )}
      </Dialog>
    </section>
  );
}

/**
 * `/spaces/:spaceId` (spaces-and-invitations D12): the two participants, the binding
 * history, the caller's own range, which opens and stops sharing once confirmed (kernel
 * D5), and unbinding.
 */
export function SpacePage() {
  const { spaceId = '' } = useParams();
  const me = useMe();
  const client = useQueryClient();
  const space = useQuery({
    queryKey: relationshipKeys.space(spaceId),
    queryFn: () => callApi('space', { params: { spaceId } }),
    retry: false,
  });
  const mine = useQuery({
    queryKey: relationshipKeys.mySharing(spaceId),
    queryFn: () => callApi('mySharing', { params: { spaceId } }),
    retry: false,
  });
  const [unbinding, setUnbinding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (space.isPending || mine.isPending || !me.data)
    return <Page className="text-ink-soft">正在打开…</Page>;
  if (space.isError || mine.isError)
    return (
      <Page>
        <p className="rounded-xl bg-notice px-4 py-3 text-sm" role="alert">
          {refusalText(space.error ?? mine.error)}
        </p>
        <Link to="/" className="mt-4 inline-block text-sm text-ink-soft underline">
          回到首页
        </Link>
      </Page>
    );

  const { space: summary, periods } = space.data;
  const partner = partnerOf(summary, me.data.user.id);
  const open = periods.find((p) => p.endedAt === null) ?? null;

  const unbind = async () => {
    if (!open) return;
    setBusy(true);
    setError(null);
    try {
      await callApi('unbind', { params: { spaceId }, body: { expectedPeriodId: open.id } });
      setUnbinding(false);
      await refreshRelationships(client);
    } catch (e) {
      setError(refusalText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page>
      <PageHeader
        title={`与 ${partner.displayName} 的空间`}
        description={
          <>
            <p>{summary.state === 'active' ? '当前绑定中' : '已解绑，只能与原搭档恢复'}</p>
            <p>参与者：{summary.participants.map((p) => p.user.displayName).join('、')}</p>
          </>
        }
        actions={
          <Button variant="outline" size="sm" onClick={() => void refreshRelationships(client)}>
            <RefreshCw aria-hidden="true" />
            刷新
          </Button>
        }
      />
      <div className="grid gap-10 md:grid-cols-[1fr_18rem]">
        <div className="grid min-w-0 content-start gap-8">
          <MyRange
            key={`${mine.data.revision}:${open?.id ?? ''}`}
            spaceId={spaceId}
            periodId={open?.id ?? null}
            mine={mine.data}
          />
          <SharedDiaryList key={spaceId} spaceId={spaceId} partner={partner.displayName} />
          <section aria-labelledby="periods-title">
            <SectionTitle id="periods-title">绑定记录</SectionTitle>
            <ul className="grid gap-2 border-l-2 border-line pl-4 text-sm">
              {periods.map((p) => (
                <li key={p.id}>
                  {timeText.format(new Date(p.startedAt))} —{' '}
                  {p.endedAt ? timeText.format(new Date(p.endedAt)) : '至今'}
                </li>
              ))}
            </ul>
          </section>
        </div>
        <aside className="grid content-start gap-4 self-start rounded-2xl bg-accent p-6 text-sm leading-relaxed">
          <h2 className="font-serif text-lg font-medium">分享时，也知道边界</h2>
          <p className="text-ink-soft">每人只共享自己确认过的日期</p>
          <p className="text-ink-soft">
            只有你能看到这个设置。确认后，范围内的日记会共享给对方并持续更新；移出范围的日记停止更新，对方保留已共享的只读版本。
          </p>
          {open ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="justify-self-start"
              onClick={() => setUnbinding(true)}
            >
              解除绑定
            </Button>
          ) : (
            <p>想恢复关系，请回到首页生成邀请，发给 {partner.displayName}。</p>
          )}
          {error && !unbinding && (
            <p className="rounded-xl bg-notice px-4 py-3" role="alert">
              {error}
            </p>
          )}
        </aside>
      </div>
      <Dialog open={unbinding} onOpenChange={(next) => !busy && setUnbinding(next)}>
        <DialogContent>
          <DialogTitle>解除绑定</DialogTitle>
          <DialogDescription className="leading-relaxed">
            解除绑定不需要对方同意。之后你们都不能与其他人绑定，只能与原搭档恢复；空间与记录都会保留。
          </DialogDescription>
          {error && (
            <p className="rounded-xl bg-notice px-4 py-3 text-sm" role="alert">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => setUnbinding(false)}
            >
              取消
            </Button>
            <Button type="button" disabled={busy} onClick={() => void unbind()}>
              确认解除绑定
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Page>
  );
}
