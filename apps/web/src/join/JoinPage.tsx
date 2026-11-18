import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useNavigate } from 'react-router';
import type { ResponseOf } from '@between-pages/contracts';
import { callApi } from '../api/client.ts';
import { useMe } from '../auth/me.ts';
import { InlineName } from '../name/index.ts';
import { isFinalRefusal, refreshRelationships, refusalText } from '../relationship/index.ts';
import { ALL_DAYS, RangeEditor, type RangeChoice } from '../sharing-range/index.ts';
import { localToday } from '../today/index.ts';
import { Button } from '../ui/index.ts';
import { WelcomeLayout } from '../windows/index.ts';
import {
  canKeepAcrossLogin,
  clearPendingInvite,
  keepPendingInvite,
  pendingInvite,
  tokenFromHash,
} from './pending.ts';

type Preview = ResponseOf<'previewInvitation'>;

const timeText = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/**
 * `/join#token=…` (spaces-and-invitations D8, D12). The fragment is read once, kept for the
 * login round trip and removed from the address. Opening, signing in and previewing bind
 * nothing; only "接受邀请" does, after the person checks both accounts.
 */
export function JoinPage() {
  const me = useMe();
  const location = useLocation();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [token, setToken] = useState<string | null>(
    () => tokenFromHash(location.hash) ?? pendingInvite(),
  );
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [choice, setChoice] = useState<RangeChoice>({ kind: 'selection', selection: ALL_DAYS });
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // A link opened while this page is already showing changes only the fragment, so the
  // page follows it here instead of keeping the previous invitation's answer.
  const [seenHash, setSeenHash] = useState(location.hash);
  const fromLink = tokenFromHash(location.hash);
  if (location.hash !== seenHash) {
    setSeenHash(location.hash);
    if (fromLink) {
      setToken(fromLink);
      setPreview(null);
      setError(null);
    }
  }

  useEffect(() => {
    if (fromLink) keepPendingInvite(fromLink);
    if (location.hash) void navigate('/join', { replace: true });
  }, [fromLink, location.hash, navigate]);

  const signedIn = me.isSuccess;
  useEffect(() => {
    if (!signedIn || !token) return;
    let live = true;
    callApi('previewInvitation', { body: { token } }).then(
      (answer) => live && setPreview(answer),
      (e: unknown) => {
        if (!live) return;
        if (isFinalRefusal(e)) {
          clearPendingInvite();
          setToken(null);
        }
        setError(refusalText(e));
      },
    );
    return () => {
      live = false;
    };
  }, [signedIn, token, attempt]);

  if (me.isPending) return <p className="px-5 py-16 text-center text-ink-soft">正在打开…</p>;
  if (me.signedOut)
    return (
      <WelcomeLayout>
        <h1 className="font-serif text-3xl font-medium">双人空间邀请</h1>
        {token && canKeepAcrossLogin() ? (
          <p className="mt-4 text-ink-soft">
            登录后回到这条邀请。
            <Link to="/login" className="text-warm underline underline-offset-4">
              去登录
            </Link>
          </p>
        ) : (
          <p className="mt-4 text-ink-soft">请先登录，再重新打开对方发来的链接。</p>
        )}
      </WelcomeLayout>
    );

  const accept = async () => {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const { binding } = await callApi('acceptInvitation', {
        body: {
          token,
          sharingSelection: choice.kind === 'selection' ? choice.selection : null,
        },
      });
      clearPendingInvite();
      await refreshRelationships(client);
      await navigate(`/spaces/${binding.space.id}`);
    } catch (e) {
      if (isFinalRefusal(e)) {
        clearPendingInvite();
        setToken(null);
        setPreview(null);
      }
      setError(refusalText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <WelcomeLayout>
      <h1 className="font-serif text-3xl font-medium">双人空间邀请</h1>
      {!token && !error && <p className="mt-4 text-ink-soft">没有可用的邀请链接。</p>}
      {preview && token && (
        <div className="mt-5 grid gap-4">
          <div className="grid gap-1 border-y border-line py-4 text-sm">
            <p>当前账号：{me.data && <InlineName name={me.data.user.displayName} />}</p>
            <p>
              邀请者：<strong className="font-medium">{preview.inviter.displayName}</strong>
            </p>
          </div>
          <p className="leading-relaxed">
            {preview.mode === 'restore'
              ? `接受后恢复你和 ${preview.inviter.displayName} 原来的双人空间。`
              : '接受后你们将建立双人空间。首版绑定后搭档固定，不支持更换或纠正，请先核对两边的账号。'}
          </p>
          <p className="text-sm leading-relaxed text-ink-soft">
            邀请 {timeText.format(new Date(preview.expiresAt))} 前有效。选择你以后愿意共享的日期，
            对方看不到这个设置；接受后，你选择的日期里的日记会共享给对方并持续更新。
          </p>
          <RangeEditor initial={ALL_DAYS} today={localToday()} allowUnset onChange={setChoice} />
          <Button type="button" className="w-full" disabled={busy} onClick={() => void accept()}>
            接受邀请
          </Button>
        </div>
      )}
      {error && (
        <p className="mt-4 rounded-xl bg-notice px-4 py-3 text-sm" role="alert">
          {error}
        </p>
      )}
      {error && token && !preview && (
        <Button
          type="button"
          variant="outline"
          className="mt-3"
          onClick={() => {
            setError(null);
            setAttempt((n) => n + 1);
          }}
        >
          重试
        </Button>
      )}
      <p className="mt-5 text-sm">
        <Link to="/" className="text-ink-soft underline underline-offset-4 hover:text-ink">
          回到首页
        </Link>
      </p>
    </WelcomeLayout>
  );
}
