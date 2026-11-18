import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { RecipientEmail, type ResponseOf } from '@between-pages/contracts';
import { ApiError, callApi } from '../api/client.ts';
import { InlineName } from '../name/index.ts';
import { ALL_DAYS, RangeEditor, type RangeChoice } from '../sharing-range/index.ts';
import { localToday } from '../today/index.ts';
import { Button, Input, Label } from '../ui/index.ts';
import { partnerOf } from './partner.ts';
import { refreshRelationships, refusalText, useBinding, useSpaces } from './queries.ts';

const timeText = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

const linkClass = 'text-warm underline underline-offset-4';

/** The link the partner opens; the token rides in the fragment, which never reaches a server. */
const joinLink = (token: string) => `${window.location.origin}/join#token=${token}`;

/**
 * The invitation flow of the 设置 → 搭档 page (spaces-and-invitations D12): the current or
 * archived space, or an invitation to create, copy once, revoke or replace. An invitation is
 * addressed to the partner's Google email by default, or a link from the same form
 * (in-app-invitation-by-email D5). Ranges set here
 * are configuration only; the panel always says diary sharing is not open yet. Above the
 * form, the name the partner will see, with "修改" (display-name D6).
 */
export function RelationshipPanel({ me }: { me: ResponseOf<'me'>['user'] }) {
  const userId = me.id;
  const binding = useBinding();
  const spaces = useSpaces();
  const client = useQueryClient();
  const [choice, setChoice] = useState<RangeChoice>({ kind: 'selection', selection: ALL_DAYS });
  // Kept until an answer arrives, so a retry after a lost response cannot open a second link.
  // Kept per recipient (null for a link), so a retry never reuses it for another request.
  const [requestId, setRequestId] = useState<{ id: string; to: string | null } | null>(null);
  const [created, setCreated] = useState<{ token: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // in-app-invitation-by-email D5: the partner's Google address, the default way to invite.
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  // "重新发出" shows the form again over a pending addressed invitation.
  const [resending, setResending] = useState(false);

  if (binding.isPending || spaces.isPending)
    return <section className="text-sm text-ink-soft">正在读取双人空间…</section>;
  if (binding.isError || spaces.isError)
    return (
      <section className="grid justify-items-start gap-3">
        <p className="text-sm">双人空间读取失败</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void refreshRelationships(client)}
        >
          重试
        </Button>
      </section>
    );

  const current = binding.data.binding;
  const archived = spaces.data.spaces.filter((s) => s.state === 'archived');
  const pending = binding.data.invitation?.state === 'pending' ? binding.data.invitation : null;
  const expiredAddressed =
    binding.data.invitation?.state === 'expired' ? binding.data.invitation.recipientEmail : null;

  /** A link, or with `recipientEmail` an invitation addressed to it; either closes the last one. */
  const create = async (recipientEmail?: string) => {
    const to = recipientEmail ?? null;
    const id = requestId?.to === to ? requestId.id : crypto.randomUUID();
    setRequestId({ id, to });
    setBusy(true);
    setError(null);
    setSent(false);
    try {
      const res = await callApi('createInvitation', {
        body: {
          requestId: id,
          sharingSelection: choice.kind === 'selection' ? choice.selection : null,
          ...(recipientEmail === undefined ? {} : { recipientEmail }),
        },
      });
      setRequestId(null);
      setResending(false);
      if (recipientEmail !== undefined) {
        // The same words whether or not the address has an account (D5, invariant 3).
        setCreated(null);
        setSent(true);
      } else if (res.token) setCreated({ token: res.token, expiresAt: res.invitation.expiresAt });
      else setError('邀请已经生成过，但链接无法再次显示，请撤销后重新生成');
      await refreshRelationships(client);
    } catch (e) {
      setError(
        e instanceof ApiError && e.code === 'SELF_INVITE' && recipientEmail !== undefined
          ? '这是你自己的登录邮箱，请填 TA 的'
          : refusalText(e),
      );
    } finally {
      setBusy(false);
    }
  };

  const sendToEmail = () => {
    if (!RecipientEmail.safeParse(email).success) {
      setSent(false);
      setError('请填 TA 登录 Google 用的完整邮箱');
      return;
    }
    void create(email);
  };

  /** "重新发出": the form again with the address filled in, sent only on another click. */
  const resend = (address: string) => {
    setEmail(address);
    setRequestId(null);
    setSent(false);
    setError(null);
    setResending(true);
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
    <section className="grid gap-4" aria-label="双人空间">
      {current && (
        <p>
          <Link to={`/spaces/${current.space.id}`} className={linkClass}>
            与 {partnerOf(current.space, userId).displayName} 的空间
          </Link>
          （当前）
        </p>
      )}
      {archived.map((space) => (
        <p key={space.id}>
          <Link to={`/spaces/${space.id}`} className={linkClass}>
            与 {partnerOf(space, userId).displayName} 的空间
          </Link>
          （已解绑）
        </p>
      ))}
      {!current && created && (
        <div className="grid gap-2 rounded-xl bg-accent p-4">
          <p className="text-sm">
            邀请链接（只显示这一次，{timeText.format(new Date(created.expiresAt))} 前有效）：
          </p>
          <Input readOnly aria-label="邀请链接" value={joinLink(created.token)} />
          <div className="flex items-center gap-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void copy(created.token)}
            >
              复制链接
            </Button>
            {copied && <span className="text-sm text-done">已复制</span>}
          </div>
        </div>
      )}
      {!current && pending?.recipientEmail && (
        <div className="grid justify-items-start gap-2 rounded-xl bg-accent p-4">
          {sent && <p className="text-sm text-done">已发出邀请</p>}
          <p className="text-sm">
            已邀请 {pending.recipientEmail}，等 TA 登录 ·{' '}
            {timeText.format(new Date(pending.expiresAt))} 前有效
          </p>
          <p className="text-sm text-ink-soft">TA 用这个邮箱登录后，会在首页看到你的邀请。</p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => resend(pending.recipientEmail!)}
            >
              重新发出
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => void revoke(pending.id)}
            >
              撤销邀请
            </Button>
          </div>
        </div>
      )}
      {!current && expiredAddressed && !resending && (
        <div className="grid justify-items-start gap-2">
          <p className="text-sm text-ink-soft">给 {expiredAddressed} 的邀请已过期</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => resend(expiredAddressed)}
          >
            重新发出
          </Button>
        </div>
      )}
      {!current && pending && !pending.recipientEmail && (
        <div className="grid justify-items-start gap-2">
          {!created && (
            <p className="text-sm text-ink-soft">
              已有一条邀请，{timeText.format(new Date(pending.expiresAt))}{' '}
              前有效。链接只在生成时显示，找不到时请撤销后重新生成。
            </p>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => void revoke(pending.id)}
          >
            撤销邀请
          </Button>
        </div>
      )}
      {!current && (!pending || resending) && (
        <div className="grid gap-4">
          <h2 className="font-serif text-xl font-medium">
            {archived.length ? '邀请原搭档恢复关系' : '邀请搭档'}
          </h2>
          <p className="text-sm text-ink-soft">
            对方会看到你叫 <InlineName name={me.displayName} />
          </p>
          <Label>
            TA 的 Google 邮箱
            <Input
              type="email"
              inputMode="email"
              autoComplete="off"
              value={email}
              aria-describedby="invite-email-help"
              onChange={(event) => setEmail(event.target.value)}
            />
          </Label>
          <p id="invite-email-help" className="-mt-2 text-sm leading-relaxed text-ink-soft">
            填 TA 登录 Google 用的完整邮箱。不会发邮件，TA
            用这个邮箱登录后会在应用里看到。对不上时可以改用邀请链接。
          </p>
          <p className="text-sm leading-relaxed text-ink-soft">
            选择你以后愿意共享的日期，对方看不到这个设置。
          </p>
          <RangeEditor initial={ALL_DAYS} today={localToday()} allowUnset onChange={setChoice} />
          <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
            <Button type="button" disabled={busy} onClick={sendToEmail}>
              发出邀请
            </Button>
            <Button
              type="button"
              variant="link"
              className="h-auto p-0"
              disabled={busy}
              onClick={() => void create()}
            >
              或者生成邀请链接
            </Button>
            {resending && (
              <Button type="button" variant="ghost" size="sm" onClick={() => setResending(false)}>
                取消
              </Button>
            )}
          </div>
        </div>
      )}
      {error && (
        <p className="rounded-xl bg-notice px-4 py-3 text-sm" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
