import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import type { ResponseOf } from '@between-pages/contracts';
import { callApi } from '../api/client.ts';
import { ALL_DAYS, RangeEditor, type RangeChoice } from '../sharing-range/index.ts';
import { refreshRelationships, refusalText, useBinding, useSpaces } from './queries.ts';

type Space = ResponseOf<'spaces'>['spaces'][number];

const timeText = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export const partnerOf = (space: Space, userId: string) =>
  space.participants.find((p) => p.user.id !== userId)!.user;

/** The link the partner opens; the token rides in the fragment, which never reaches a server. */
const joinLink = (token: string) => `${window.location.origin}/join#token=${token}`;

/**
 * The home page's relationship section (spaces-and-invitations D12): the current or archived
 * space, or an invitation to create, copy once, revoke or replace. Ranges set here are
 * configuration only; the panel always says diary sharing is not open yet.
 */
export function RelationshipPanel({ userId }: { userId: string }) {
  const binding = useBinding();
  const spaces = useSpaces();
  const client = useQueryClient();
  const [choice, setChoice] = useState<RangeChoice>({ kind: 'selection', selection: ALL_DAYS });
  // Kept until an answer arrives, so a retry after a lost response cannot open a second link.
  const [requestId, setRequestId] = useState<string | null>(null);
  const [created, setCreated] = useState<{ token: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  if (binding.isPending || spaces.isPending)
    return <section className="relationship">正在读取双人空间…</section>;
  if (binding.isError || spaces.isError)
    return (
      <section className="relationship">
        <p>双人空间读取失败</p>
        <button type="button" onClick={() => void refreshRelationships(client)}>
          重试
        </button>
      </section>
    );

  const current = binding.data.binding;
  const archived = spaces.data.spaces.filter((s) => s.state === 'archived');
  const pending = binding.data.invitation?.state === 'pending' ? binding.data.invitation : null;

  const create = async () => {
    if (choice.kind === 'invalid') return;
    const id = requestId ?? crypto.randomUUID();
    setRequestId(id);
    setBusy(true);
    setError(null);
    try {
      const res = await callApi('createInvitation', {
        body: {
          requestId: id,
          sharingSelection: choice.kind === 'selection' ? choice.selection : null,
        },
      });
      setRequestId(null);
      if (res.token) setCreated({ token: res.token, expiresAt: res.invitation.expiresAt });
      else setError('邀请已经生成过，但链接无法再次显示，请撤销后重新生成');
      await refreshRelationships(client);
    } catch (e) {
      setError(refusalText(e));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (inviteId: string) => {
    setBusy(true);
    setError(null);
    try {
      await callApi('revokeInvitation', { params: { inviteId }, body: {} });
      setCreated(null);
      await refreshRelationships(client);
    } catch (e) {
      setError(refusalText(e));
    } finally {
      setBusy(false);
    }
  };

  const copy = async (token: string) => {
    try {
      await navigator.clipboard.writeText(joinLink(token));
      setCopied(true);
    } catch {
      // Clipboard permission refused: the link stays visible to copy by hand.
      setCopied(false);
    }
  };

  return (
    <section className="relationship" aria-labelledby="relationship-title">
      <h2 id="relationship-title">双人空间</h2>
      <p className="relationship-note">范围已设置，日记共享尚未开放</p>
      {current && (
        <p>
          <Link to={`/spaces/${current.space.id}`}>
            与 {partnerOf(current.space, userId).displayName} 的空间
          </Link>
          （当前）
        </p>
      )}
      {archived.map((space) => (
        <p key={space.id}>
          <Link to={`/spaces/${space.id}`}>与 {partnerOf(space, userId).displayName} 的空间</Link>
          （已解绑）
        </p>
      ))}
      {!current && created && (
        <div className="invitation">
          <p>邀请链接（只显示这一次，{timeText.format(new Date(created.expiresAt))} 前有效）：</p>
          <input readOnly aria-label="邀请链接" value={joinLink(created.token)} />
          <button type="button" onClick={() => void copy(created.token)}>
            复制链接
          </button>
          {copied && <span>已复制</span>}
        </div>
      )}
      {!current && pending && (
        <div className="invitation">
          {!created && (
            <p>
              已有一条邀请，{timeText.format(new Date(pending.expiresAt))}{' '}
              前有效。链接只在生成时显示，找不到时请撤销后重新生成。
            </p>
          )}
          <button type="button" disabled={busy} onClick={() => void revoke(pending.id)}>
            撤销邀请
          </button>
        </div>
      )}
      {!current && !pending && (
        <div className="invitation">
          <h3>{archived.length ? '邀请原搭档恢复关系' : '邀请搭档'}</h3>
          <p className="range-help">
            首版绑定后搭档固定，不支持更换。选择你以后愿意共享的日期，对方看不到这个设置。
          </p>
          <RangeEditor initial={ALL_DAYS} allowUnset onChange={setChoice} />
          <button
            type="button"
            className="primary"
            disabled={busy || choice.kind === 'invalid'}
            onClick={() => void create()}
          >
            生成邀请链接
          </button>
        </div>
      )}
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
