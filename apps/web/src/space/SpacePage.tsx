import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import type { DateSelection, ResponseOf } from '@between-pages/contracts';
import { callApi } from '../api/client.ts';
import { BookSpread } from '../book/index.ts';
import { useMe } from '../auth/me.ts';
import {
  partnerOf,
  refreshRelationships,
  refusalText,
  relationshipKeys,
} from '../relationship/index.ts';
import { SharedDiaryList } from '../shared-diaries/index.ts';
import {
  MonthView,
  NO_DAYS,
  RangeEditor,
  daysOnlyIn,
  describeRanges,
  describeSelection,
  type RangeChoice,
} from '../sharing-range/index.ts';

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
        <p className="share-change">
          将开放：{describeRanges(opening)}
          。对方会看到这些日期日记的当前正文和以后的编辑，看不到未共享期间的历史；这些日记的撤销记录从开放时重新开始。
        </p>
      )}
      {stopping.length > 0 && (
        <p className="share-change">
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

  return (
    <section className="my-range" aria-labelledby="my-range-title">
      <h2 id="my-range-title">我的共享范围</h2>
      <p className="range-help">
        只有你能看到这个设置。确认后，范围内的日记会共享给对方并持续更新；移出范围的日记停止更新，对方保留已共享的只读版本。
      </p>
      <p>
        {mine.revision === 0 ? '还没有设置过共享范围' : describeSelection(mine.selection)}
        {periodId !== null &&
          (confirmedNow
            ? '（已为本次绑定确认，正在共享）'
            : '（尚未为本次绑定确认，日记没有共享；之前的设置仅供参考）')}
      </p>
      {periodId === null ? (
        <MonthView selection={mine.selection} />
      ) : confirming ? (
        <div className="range-confirm">
          <p>原来：{mine.revision === 0 ? '未设置' : describeSelection(mine.selection)}</p>
          <p>保存后：{describeSelection(confirming)}</p>
          <ChangePreview now={confirmedNow ? mine.selection : NO_DAYS} next={confirming} />
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => void save(confirming)}
          >
            {busy ? '正在准备共享…' : '确认保存'}
          </button>
          <button type="button" disabled={busy} onClick={() => setConfirming(null)}>
            取消
          </button>
        </div>
      ) : (
        <>
          <RangeEditor
            initial={mine.selection}
            onChange={(c) => {
              setChoice(c);
              setSaved(false);
            }}
          />
          <button
            type="button"
            className="primary"
            disabled={choice.kind !== 'selection'}
            onClick={() => choice.kind === 'selection' && setConfirming(choice.selection)}
          >
            保存范围
          </button>
        </>
      )}
      {saved && <p role="status">范围已保存</p>}
      {error && (
        <p className="notice" role="alert">
          {error}
          <button
            type="button"
            onClick={() => {
              setError(null);
              setRequestId(null);
              setConfirming(null);
              void refreshRelationships(client);
            }}
          >
            重新载入
          </button>
        </p>
      )}
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

  if (space.isPending || mine.isPending || !me.data) return <p className="status">正在打开…</p>;
  if (space.isError || mine.isError)
    return (
      <main className="space">
        <BookSpread
          left={
            <>
              <p className="notice" role="alert">
                {refusalText(space.error ?? mine.error)}
              </p>
              <Link to="/">回到首页</Link>
            </>
          }
          right={null}
        />
      </main>
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
    <main className="space">
      <BookSpread
        left={
          <>
            <header>
              <Link className="book-back" to="/">
                ← 序言
              </Link>
              <button type="button" onClick={() => void refreshRelationships(client)}>
                刷新
              </button>
            </header>
            <h1>与 {partner.displayName} 的空间</h1>
            <p>{summary.state === 'active' ? '当前绑定中' : '已解绑，只能与原搭档恢复'}</p>
            <p className="relationship-note">每人只共享自己确认过的日期</p>
            <p>参与者：{summary.participants.map((p) => p.user.displayName).join('、')}</p>
            <section aria-labelledby="periods-title">
              <h2 id="periods-title">绑定记录</h2>
              <ul className="periods">
                {periods.map((p) => (
                  <li key={p.id}>
                    {timeText.format(new Date(p.startedAt))} —{' '}
                    {p.endedAt ? timeText.format(new Date(p.endedAt)) : '至今'}
                  </li>
                ))}
              </ul>
            </section>
            <SharedDiaryList key={spaceId} spaceId={spaceId} partner={partner.displayName} />
          </>
        }
        right={
          <>
            <MyRange
              key={`${mine.data.revision}:${open?.id ?? ''}`}
              spaceId={spaceId}
              periodId={open?.id ?? null}
              mine={mine.data}
            />
            {open && (
              <section className="unbind">
                {unbinding ? (
                  <>
                    <p>
                      解除绑定不需要对方同意。之后你们都不能与其他人绑定，只能与原搭档恢复；空间与记录都会保留。
                    </p>
                    <button type="button" disabled={busy} onClick={() => void unbind()}>
                      确认解除绑定
                    </button>
                    <button type="button" disabled={busy} onClick={() => setUnbinding(false)}>
                      取消
                    </button>
                  </>
                ) : (
                  <button type="button" onClick={() => setUnbinding(true)}>
                    解除绑定
                  </button>
                )}
              </section>
            )}
            {!open && <p>想恢复关系，请回到首页生成邀请，发给 {partner.displayName}。</p>}
            {error && (
              <p className="notice" role="alert">
                {error}
              </p>
            )}
          </>
        }
      />
    </main>
  );
}
