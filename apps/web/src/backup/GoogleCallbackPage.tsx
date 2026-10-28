import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { ApiError, callApi } from '../api/client.ts';

// Where Google sends the browser back (server-backup-and-google-docs D10). The page hands
// code and state to the API, which checks the state against this session; the code and
// state are not kept anywhere in the browser.

const ERROR_TEXT: Record<string, string> = {
  GOOGLE_STATE_INVALID: '这次连接已过期或不是从这里发起的，请回到备份页重新连接',
  GOOGLE_EXCHANGE_FAILED: 'Google 没有给出 Drive 授权，请重新连接',
  GOOGLE_DISCONNECTING: '上一次连接还在断开中，请稍等片刻再连接',
  GOOGLE_UNAVAILABLE: '这台服务器还没有配置 Google 备份',
};

export function GoogleCallbackPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const code = params.get('code');
  const state = params.get('state');
  // Google came back without a code: the user declined, or the round trip broke.
  const refused =
    code && state
      ? null
      : params.get('error') === 'access_denied'
        ? '你没有同意 Drive 授权，Google 备份未开启'
        : '连接没有完成，请重新连接';
  const [error, setError] = useState<string | null>(null);
  const sent = useRef(false);

  useEffect(() => {
    if (sent.current || !code || !state) return;
    sent.current = true;
    void (async () => {
      try {
        const { backup } = await callApi('finishGoogleConnection', { body: { code, state } });
        queryClient.setQueryData(['backup'], backup);
        await navigate('/backup', { replace: true });
      } catch (e) {
        setError((e instanceof ApiError && ERROR_TEXT[e.code]) || '连接失败，请稍后再试');
      }
    })();
  }, [code, state, navigate, queryClient]);

  const shown = refused ?? error;
  return (
    <main className="page backup">
      {shown ? (
        <>
          <p role="alert">{shown}</p>
          <Link to="/backup" replace>
            回到备份页
          </Link>
        </>
      ) : (
        <p>正在连接 Google Drive…</p>
      )}
    </main>
  );
}
