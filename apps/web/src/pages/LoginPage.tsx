import { useState, type FormEvent } from 'react';
import { Navigate, useSearchParams } from 'react-router';
import { signIn, type Provider } from '../api/auth.ts';
import { useMe } from '../auth/me.ts';
import { Button, Input } from '../ui/index.ts';
import { WelcomeLayout } from '../windows/index.ts';

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
    <WelcomeLayout>
      <h1 className="font-serif text-3xl font-medium">Between Pages</h1>
      <p className="mt-3 text-sm text-ink-soft">各自生活，在同一页相遇。</p>
      {error && (
        <p className="mt-5 rounded-xl bg-notice px-4 py-3 text-sm" role="alert">
          {error}
        </p>
      )}
      {failed && (
        <p className="mt-5 rounded-xl bg-notice px-4 py-3 text-sm" role="alert">
          无法连接登录服务，请稍后再试
        </p>
      )}
      <Button
        type="button"
        className="mt-6 w-full"
        disabled={pending !== null}
        onClick={() => void start('google')}
      >
        {pending === 'google' ? '正在前往 Google…' : '使用 Google 登录'}
      </Button>
      <p className="mt-4 text-sm text-ink-soft">登录与 Google 日记备份分别授权。</p>
      {import.meta.env.DEV && (
        <form
          className="mt-6 grid gap-2 border-t border-dashed border-line pt-5"
          onSubmit={onDevSubmit}
        >
          <label htmlFor="dev-name" className="text-sm text-ink-soft">
            开发登录
          </label>
          <Input
            id="dev-name"
            value={devName}
            placeholder="名字，例如 alice"
            onChange={(event) => setDevName(event.target.value)}
          />
          <Button type="submit" variant="outline" disabled={pending !== null || !devName.trim()}>
            开发登录
          </Button>
        </form>
      )}
    </WelcomeLayout>
  );
}
