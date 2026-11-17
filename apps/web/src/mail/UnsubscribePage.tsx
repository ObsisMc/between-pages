import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { callApi } from '../api/client.ts';
import { Page, PageHeader } from '../shell/index.ts';
import { Button } from '../ui/index.ts';
import { CATEGORY_NAME, type MailCategory } from './queries.ts';

// `/unsubscribe?token=…` from a mail's footer (email-reminders D8). No login: the token alone
// decides. Opening the page changes nothing, so a mail provider fetching the link ahead of
// the person unsubscribes no one; only the button does.

export function UnsubscribePage() {
  const [params] = useSearchParams();
  const token = params.get('token');
  const category = useQuery({
    queryKey: ['unsubscribe', token],
    queryFn: async () =>
      (await callApi('unsubscribeCategory', { query: { token: token! } })).category,
    enabled: !!token,
    retry: false,
  });
  const [done, setDone] = useState<MailCategory | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const invalid = !token || category.isError;

  const confirm = async (category: MailCategory) => {
    setBusy(true);
    setError(null);
    try {
      await callApi('unsubscribe', { query: { token: token! }, body: {} });
      setDone(category);
    } catch {
      setError('没能退订，请稍后再试');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page className="max-w-xl">
      <PageHeader title="邮件提醒" />
      {invalid && (
        <p role="alert" className="text-ink">
          这个退订链接无效。可以登录后在<Link to="/mail">邮件提醒</Link>里关掉提醒。
        </p>
      )}
      {category.data && !done && (
        <div className="grid justify-items-start gap-5">
          <p className="text-lg text-ink">不再收到「{CATEGORY_NAME[category.data]}」邮件？</p>
          <p className="text-sm text-ink-soft">
            只关这一类，其他提醒照常。之后可以在设置里再打开。
          </p>
          <Button onClick={() => void confirm(category.data)} disabled={busy}>
            不再收到
          </Button>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </div>
      )}
      {done && (
        <p role="status" className="text-ink">
          已退订「{CATEGORY_NAME[done]}」邮件。
          <Link to="/mail">管理邮件提醒</Link>
        </p>
      )}
    </Page>
  );
}
