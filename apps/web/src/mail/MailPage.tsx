import { useId, useState } from 'react';
import { Link } from 'react-router';
import { Page, PageHeader, SectionTitle } from '../shell/index.ts';
import { Switch } from '../ui/index.ts';
import { useMailSettings, useSaveMail, type MailSettings } from './queries.ts';

// 设置 → 邮件提醒 (email-reminders D8): the caller's own three switches, the address mails go
// to, and one fixed sentence about previews that every person sees the same, whatever the
// partner chose (D9 第 4 条).

type Switchable = 'newContent' | 'anniversary' | 'backup';

const SWITCHES: { key: Switchable; title: string; text: string }[] = [
  {
    key: 'newContent',
    title: '有新内容',
    text: 'TA 在日记、共享页面、心愿与礼物里写了新内容，你一小时没读时发一封。两封至少隔 4 小时，每天最多 2 封。',
  },
  { key: 'anniversary', title: '纪念日', text: '纪念日到了你设的提醒期时发一封。' },
  { key: 'backup', title: '备份', text: 'Google 备份需要你处理，或者一天没成功时发一封。' },
];

function Row({
  item,
  settings,
  onChange,
  busy,
}: {
  item: (typeof SWITCHES)[number];
  settings: MailSettings;
  onChange: (key: Switchable, on: boolean) => void;
  busy: boolean;
}) {
  const id = useId();
  return (
    <li className="flex items-start justify-between gap-6 border-b border-line py-5 last:border-b-0">
      <div>
        <label htmlFor={id} className="font-medium text-ink">
          {item.title}
        </label>
        <p id={`${id}-text`} className="mt-1 text-sm leading-relaxed text-ink-soft">
          {item.text}
        </p>
      </div>
      <Switch
        id={id}
        aria-describedby={`${id}-text`}
        checked={settings[item.key]}
        disabled={busy}
        onCheckedChange={(on) => onChange(item.key, on)}
      />
    </li>
  );
}

export function MailPage() {
  const settings = useMailSettings();
  const save = useSaveMail();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const change = async (key: Switchable, on: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await save({ [key]: on });
    } catch {
      setError('没能保存，请稍后再试');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page>
      <PageHeader title="邮件提醒" description="不打开应用，也知道 TA 写了什么。" />
      {settings.isError && (
        <p role="alert" className="rounded-xl bg-notice px-4 py-3 text-sm text-ink">
          读取设置失败，请稍后再试
        </p>
      )}
      {settings.data && (
        <div className="grid max-w-2xl gap-10">
          <section>
            <ul className="grid">
              {SWITCHES.map((item) => (
                <Row
                  key={item.key}
                  item={item}
                  settings={settings.data}
                  onChange={change}
                  busy={busy}
                />
              ))}
            </ul>
            {error && (
              <p role="alert" className="mt-3 text-sm text-destructive">
                {error}
              </p>
            )}
            <p className="mt-4 text-sm leading-relaxed text-ink-soft">
              睡觉时段不发：按你在<Link to="/clocks">两地时间</Link>
              里设的作息，没设时按当地 23:00～8:00。每封邮件里都能一键退订这一类。
            </p>
          </section>
          <section>
            <SectionTitle className="font-sans text-base">收件地址</SectionTitle>
            <p className="text-ink">{settings.data.address}</p>
            <p className="mt-1 text-sm text-ink-soft">登录用的 Google 邮箱，暂时不能更改。</p>
          </section>
          <p className="rounded-xl bg-accent px-4 py-3 text-sm leading-relaxed text-ink">
            你写的字可能以约 50 字的预览出现在 TA 的提醒邮件里，发出后删改不会同步到邮件。
          </p>
        </div>
      )}
    </Page>
  );
}
