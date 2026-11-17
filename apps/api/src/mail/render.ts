import { jsx, jsxs } from 'react/jsx-runtime';
import type { ReactNode } from 'react';
import {
  Body,
  Button,
  Container,
  Head,
  Hr,
  Html,
  Link,
  Preview,
  Text,
  render,
} from '@react-email/components';
import type { Category } from './tokens.ts';

// The three reminder emails (email-reminders D5–D8), rendered by React Email into HTML and
// plain text. Composed with jsx() rather than JSX syntax: Node runs the API's TypeScript
// as is and cannot load .tsx (D10 技术设计). Every name and preview passes through React's
// escaping; nothing here is raw HTML. Chinese only (本文不负责: 英文邮件).

export type NewContentMail = {
  category: 'new_content';
  partnerName: string;
  /** Dates (YYYY-MM-DD) of diaries holding new text, any order. */
  diaryDates: string[];
  sharedPages: boolean;
  wishes: boolean;
  /** The first new text of the latest such diary, unshortened; see `previewOf`. */
  preview: { date: string; text: string } | null;
  /** The recipient's local year: dates in it are written without the year. */
  thisYear: number;
};

export type AnniversaryMail = {
  category: 'anniversary';
  anniversaryId: string;
  kind: 'birthday' | 'together' | 'other';
  /** Whose birthday, as the recipient sees it. */
  birthdayOf: 'me' | 'partner' | null;
  name: string | null;
  type: 'yearly' | 'count';
  years: number | null;
  count: number | null;
  daysLeft: number;
  partnerName: string;
};

export type BackupMail = {
  category: 'backup';
  reason: 'reconnect' | 'storage_full' | 'failing' | 'expiring';
};

export type Mail = NewContentMail | AnniversaryMail | BackupMail;

export type Rendered = {
  subject: string;
  html: string;
  text: string;
  /** RFC 8058 one-click unsubscribe (D8). */
  headers: Record<string, string>;
};

/** The site and the recipient's unsubscribe token for this mail's category. */
export type Envelope = { origin: string; token: string };

const PREVIEW_GRAPHEMES = 50;
const graphemes = new Intl.Segmenter('zh', { granularity: 'grapheme' });

const fold = (text: string) => text.replace(/\s+/g, ' ').trim();
const SPACE = /^\s+$/u;

/**
 * The preview of a run of new text (D5): at most 50 grapheme clusters with whitespace
 * folded, "……" when cut. `units` is how many UTF-16 units of `raw` it shows, so the
 * caller can check later that those characters still exist.
 */
export function previewOf(raw: string): { shown: string; units: number } {
  let count = 0;
  let units = 0;
  let space = false;
  for (const { segment } of graphemes.segment(raw)) {
    if (SPACE.test(segment)) {
      space = count > 0;
      units += segment.length;
      continue;
    }
    const next = count + (space ? 1 : 0) + 1;
    if (next > PREVIEW_GRAPHEMES) return { shown: `${fold(raw.slice(0, units))}……`, units };
    count = next;
    space = false;
    units += segment.length;
  }
  return { shown: fold(raw), units: raw.length };
}

const parts = (iso: string) => iso.split('-').map(Number) as [number, number, number];

/** "11 月 16 日、17 日", oldest first; a month or year is written when it changes. */
export function datesText(dates: readonly string[], thisYear: number): string {
  let year = thisYear;
  let month = 0;
  return [...dates]
    .sort()
    .map((iso) => {
      const [y, m, d] = parts(iso);
      const text = `${y !== year ? `${y} 年 ` : ''}${y !== year || m !== month ? `${m} 月 ` : ''}${d} 日`;
      year = y;
      month = m;
      return text;
    })
    .join('、');
}

const dayText = (iso: string) => {
  const [, m, d] = parts(iso);
  return `${m} 月 ${d} 日`;
};

function newContent(mail: NewContentMail) {
  const { partnerName: name, diaryDates, sharedPages, wishes } = mail;
  const areas = [diaryDates.length > 0, sharedPages, wishes].filter(Boolean).length;
  const subject =
    diaryDates.length || areas > 1
      ? `${name}写了新内容`
      : sharedPages
        ? `${name}更新了共享页面`
        : `${name}更新了心愿与礼物`;
  const lines = [
    ...(diaryDates.length ? [`${datesText(diaryDates, mail.thisYear)}的日记`] : []),
    ...(sharedPages ? ['共享页面有更新'] : []),
    ...(wishes ? ['心愿与礼物有更新'] : []),
  ];
  const path =
    areas > 1
      ? '/'
      : diaryDates.length === 1
        ? `/days/${diaryDates[0]}`
        : diaryDates.length
          ? '/days'
          : sharedPages
            ? '/shared-pages'
            : '/wishes';
  const body = [
    paragraph(`${name}写了新内容：`),
    ...lines.map((line) => paragraph(`· ${line}`, { margin: '4px 0' })),
    ...(mail.preview
      ? [
          paragraph(`${dayText(mail.preview.date)}的日记里：`, { marginTop: '20px' }),
          paragraph(`「${previewOf(mail.preview.text).shown}」`, { color: '#4a4036' }),
        ]
      : []),
  ];
  return { subject, body, button: { label: '去看看', path } };
}

/** What the day is, as the home strip names it, with the partner's name for "TA". */
function eventText(mail: AnniversaryMail): string {
  const { type, years, count } = mail;
  if (mail.kind === 'birthday') {
    const whose = mail.birthdayOf === 'me' ? '你的' : `${mail.partnerName}的`;
    return type === 'yearly' && years ? `${whose} ${years} 岁生日` : `${whose}生日`;
  }
  const what = mail.kind === 'together' ? '在一起' : (mail.name ?? '');
  if (type === 'count') return `${what}第 ${count} 天`;
  if (years) return `${what} ${years} 周年`;
  return mail.kind === 'together' ? '在一起的日子' : what;
}

function anniversary(mail: AnniversaryMail) {
  const event = eventText(mail);
  const subject = mail.daysLeft === 0 ? `今天是${event}` : `${event}还有 ${mail.daysLeft} 天`;
  return {
    subject,
    body: [paragraph(`${subject}。`)],
    button: { label: '看看这个纪念日', path: `/anniversaries/${mail.anniversaryId}` },
  };
}

const BACKUP_SUBJECTS: Record<BackupMail['reason'], string> = {
  reconnect: 'Google 备份需要重新连接',
  storage_full: 'Google Drive 空间已满，备份已暂停',
  failing: 'Google 备份一天没成功，正在自动重试',
  expiring: 'Google 备份的授权快到期了，请重新连接',
};
const BACKUP_BODIES: Record<BackupMail['reason'], string> = {
  reconnect: '日记暂时没有写进你的 Google Drive。重新连接后，没写进去的日子会自动补上。',
  storage_full: '你的 Google Drive 空间满了，日记暂时没有写进去。腾出空间后会自动继续。',
  failing: '最近一天日记没能写进你的 Google Drive，不需要你操作，系统会继续重试。',
  expiring: '这个服务器上的 Google 授权几天后会失效，重新连接后备份照常继续。',
};

function backup(mail: BackupMail) {
  return {
    subject: BACKUP_SUBJECTS[mail.reason],
    body: [paragraph(BACKUP_BODIES[mail.reason])],
    button: { label: '打开备份', path: '/backup' },
  };
}

const paragraph = (text: string, style: Record<string, string> = {}) =>
  jsx(Text, {
    style: { fontSize: '16px', lineHeight: '26px', margin: '8px 0', ...style },
    children: text,
  });

const MUTED = { fontSize: '13px', lineHeight: '20px', color: '#8a7f73', margin: '4px 0' };

function document(
  subject: string,
  body: ReactNode[],
  button: { label: string; url: string },
  links: { unsubscribe: string; manage: string },
) {
  return jsxs(Html, {
    lang: 'zh-CN',
    children: [
      jsx(Head, {}),
      jsx(Preview, { children: subject }),
      jsx(Body, {
        style: { backgroundColor: '#f6f1e9', fontFamily: 'sans-serif', color: '#2f2924' },
        children: jsxs(Container, {
          style: { maxWidth: '520px', padding: '32px 24px', backgroundColor: '#fffdf8' },
          children: [
            ...body,
            jsx(Button, {
              href: button.url,
              style: {
                marginTop: '20px',
                padding: '10px 20px',
                borderRadius: '6px',
                backgroundColor: '#7a5c3e',
                color: '#ffffff',
                fontSize: '15px',
              },
              children: button.label,
            }),
            jsx(Hr, { style: { margin: '28px 0 12px', borderColor: '#e6ddd0' } }),
            jsx(Text, { style: MUTED, children: '这封信由 Between Pages 自动发出。' }),
            jsxs(Text, {
              style: MUTED,
              children: [
                jsx(Link, {
                  href: links.unsubscribe,
                  style: { color: '#8a7f73' },
                  children: '不再收到这类邮件',
                }),
                ' · ',
                jsx(Link, {
                  href: links.manage,
                  style: { color: '#8a7f73' },
                  children: '管理邮件提醒',
                }),
              ],
            }),
          ],
        }),
      }),
    ],
  });
}

const BUILDERS: {
  [C in Category]: (mail: Extract<Mail, { category: C }>) => ReturnType<typeof backup>;
} = {
  new_content: newContent,
  anniversary,
  backup,
};

/** Subject, HTML, plain text and unsubscribe headers of one mail. */
export async function renderMail(mail: Mail, envelope: Envelope): Promise<Rendered> {
  const built = (BUILDERS[mail.category] as (m: Mail) => ReturnType<typeof backup>)(mail);
  const token = encodeURIComponent(envelope.token);
  const oneClick = `${envelope.origin}/api/mail/unsubscribe?token=${token}`;
  const element = document(
    built.subject,
    built.body,
    { label: built.button.label, url: `${envelope.origin}${built.button.path}` },
    {
      unsubscribe: `${envelope.origin}/unsubscribe?token=${token}`,
      manage: `${envelope.origin}/mail`,
    },
  );
  return {
    subject: built.subject,
    html: await render(element),
    text: await render(element, { plainText: true }),
    headers: {
      'List-Unsubscribe': `<${oneClick}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
}
