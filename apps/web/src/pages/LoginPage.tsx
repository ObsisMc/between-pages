import { useState, type FormEvent } from 'react';
import { Navigate, useSearchParams } from 'react-router';
import { signIn, type Provider } from '../api/auth.ts';
import { useMe } from '../auth/me.ts';
import { BookOpening, BookSpread } from '../book/index.ts';

// Better Auth error codes from `?error=` (authentication-and-sessions D10); anything
// else falls back to a generic retry message.
const ERROR_TEXT: Record<string, string> = {
  account_not_linked:
    '这个 Google 账号的邮箱已被另一个账号使用。请换一个 Google 账号登录，或联系我们处理。',
  access_denied: '你取消了 Google 授权，需要授权才能登录。',
  state_mismatch: '登录已过期，请重新登录。',
  invalid_callback_request: '登录已过期，请重新登录。',
  no_code: '登录已过期，请重新登录。',
};
const FALLBACK_ERROR = '登录没有成功，请重试。';

export function loginErrorText(code: string | null): string | null {
  if (!code) return null;
  return ERROR_TEXT[code] ?? FALLBACK_ERROR;
}

export interface LoginPageProps {
  /** Sends the browser to the provider; replaced in tests. */
  goTo?: (url: string) => void;
}

export function LoginPage({ goTo = (url) => window.location.assign(url) }: LoginPageProps) {
  const me = useMe();
  const [params] = useSearchParams();
  const [pending, setPending] = useState<Provider | null>(null);
  const [failed, setFailed] = useState(false);
  const [devName, setDevName] = useState('');

  if (me.isSuccess) return <Navigate to="/" replace />;

  const start = async (provider: Provider, hint?: string) => {
    setPending(provider);
    setFailed(false);
    try {
      goTo(await signIn(provider, hint));
    } catch {
      setPending(null);
      setFailed(true);
    }
  };
  const onDevSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (devName.trim()) void start('dev', devName.trim());
  };
  const error = loginErrorText(params.get('error'));

  return (
    <main className="login">
      <BookSpread
        left={<BookOpening together />}
        right={
          <>
            <h1>登录</h1>
            <p className="tagline">各自生活，在同一页相遇。</p>
            {error && (
              <p className="notice" role="alert">
                {error}
              </p>
            )}
            {failed && (
              <p className="notice" role="alert">
                无法连接登录服务，请稍后再试
              </p>
            )}
            <button
              type="button"
              className="primary"
              disabled={pending !== null}
              onClick={() => void start('google')}
            >
              {pending === 'google' ? '正在前往 Google…' : '使用 Google 登录'}
            </button>
            {import.meta.env.DEV && (
              <form className="dev-login" onSubmit={onDevSubmit}>
                <label htmlFor="dev-name">开发登录</label>
                <input
                  id="dev-name"
                  value={devName}
                  placeholder="名字，例如 alice"
                  onChange={(event) => setDevName(event.target.value)}
                />
                <button type="submit" disabled={pending !== null || !devName.trim()}>
                  开发登录
                </button>
              </form>
            )}
          </>
        }
      />
    </main>
  );
}
