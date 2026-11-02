import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useNavigate } from 'react-router';
import type { ResponseOf } from '@between-pages/contracts';
import { callApi } from '../api/client.ts';
import { BookOpening, BookSpread } from '../book/index.ts';
import { useMe } from '../auth/me.ts';
import { isFinalRefusal, refreshRelationships, refusalText } from '../relationship/index.ts';
import { ALL_DAYS, RangeEditor, type RangeChoice } from '../sharing-range/index.ts';
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

  if (me.isPending)
    return (
      <main className="join">
        <BookSpread left={<BookOpening together={false} />} right={null} />
      </main>
    );
  if (me.signedOut)
    return (
      <main className="join">
        <BookSpread
          left={<BookOpening together={false} />}
          right={
            <>
              <h1>双人空间邀请</h1>
              {token && canKeepAcrossLogin() ? (
                <p>
                  登录后回到这条邀请。<Link to="/login">去登录</Link>
                </p>
              ) : (
                <p>请先登录，再重新打开对方发来的链接。</p>
              )}
            </>
          }
        />
      </main>
    );

  const accept = async () => {
    if (!token || choice.kind === 'invalid') return;
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
    <main className="join">
      <BookSpread
        left={<BookOpening together={false} />}
        right={
          <>
            <h1>双人空间邀请</h1>
            {!token && !error && <p>没有可用的邀请链接。</p>}
            {preview && token && (
              <>
                <p>
                  当前账号：<strong>{me.data?.user.displayName}</strong>
                </p>
                <p>
                  邀请者：<strong>{preview.inviter.displayName}</strong>
                </p>
                <p>
                  {preview.mode === 'restore'
                    ? `接受后恢复你和 ${preview.inviter.displayName} 原来的双人空间。`
                    : '接受后你们将建立双人空间。首版绑定后搭档固定，不支持更换或纠正，请先核对两边的账号。'}
                </p>
                <p className="range-help">
                  邀请 {timeText.format(new Date(preview.expiresAt))}{' '}
                  前有效。选择你以后愿意共享的日期，
                  对方看不到这个设置；接受后，你选择的日期里的日记会共享给对方并持续更新。
                </p>
                <RangeEditor initial={ALL_DAYS} allowUnset onChange={setChoice} />
                <button
                  type="button"
                  className="primary"
                  disabled={busy || choice.kind === 'invalid'}
                  onClick={() => void accept()}
                >
                  接受邀请
                </button>
              </>
            )}
            {error && (
              <p className="notice" role="alert">
                {error}
              </p>
            )}
            {error && token && !preview && (
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  setAttempt((n) => n + 1);
                }}
              >
                重试
              </button>
            )}
            <p>
              <Link to="/">回到首页</Link>
            </p>
          </>
        }
      />
    </main>
  );
}
