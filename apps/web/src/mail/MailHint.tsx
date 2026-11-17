import { useState } from 'react';
import { Link } from 'react-router';
import { X } from 'lucide-react';
import { useMailSettings, useSaveMail } from './queries.ts';

// The home's one-time notice (email-reminders D8): reminders are on by default, so each
// person is told once, and the server remembers that it was closed.
export function MailHint() {
  const settings = useMailSettings().data;
  const save = useSaveMail();
  const [closing, setClosing] = useState(false);
  if (!settings || settings.hintDismissed || closing) return null;
  return (
    <p
      role="status"
      className="mb-6 flex items-center gap-3 rounded-xl bg-accent px-4 py-3 text-sm text-ink"
    >
      <span className="flex-1">
        邮件提醒已开启，可在设置里关闭 ·{' '}
        <Link to="/mail" className="text-warm underline underline-offset-4">
          邮件提醒设置
        </Link>
      </span>
      <button
        type="button"
        aria-label="不再显示"
        className="rounded-full p-1 text-ink-soft hover:text-ink [&_svg]:size-4"
        onClick={() => {
          setClosing(true);
          void save({ dismissHint: true }).catch(() => setClosing(false));
        }}
      >
        <X aria-hidden="true" />
      </button>
    </p>
  );
}
