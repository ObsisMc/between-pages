import { describe, expect, it } from 'vitest';
import { datesText, previewOf, renderMail, type Mail } from './render.ts';

// The three reminder mails (email-reminders D5–D8), rendered by React Email.

const envelope = { origin: 'https://site.test', token: 'TOKEN' };
const newContent = (over: Partial<Extract<Mail, { category: 'new_content' }>> = {}): Mail => ({
  category: 'new_content',
  partnerName: '小红',
  diaryDates: ['2026-11-17'],
  sharedPages: false,
  wishes: false,
  preview: { date: '2026-11-17', text: '今天' },
  thisYear: 2026,
  ...over,
});

describe('reminder mails', () => {
  it('escapes names and previews in HTML and keeps them as text', async () => {
    const mail = await renderMail(
      newContent({ partnerName: '<b>A&B</b>', preview: { date: '2026-11-17', text: '<script>&' } }),
      envelope,
    );
    expect(mail.subject).toBe('<b>A&B</b>写了新内容');
    expect(mail.html).not.toContain('<b>A&B</b>');
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;b&gt;A&amp;B&lt;/b&gt;');
    expect(mail.html).toContain('&lt;script&gt;&amp;');
    expect(mail.text).toContain('「<script>&」');
  });

  it('carries both unsubscribe headers and both footer links in the plain text', async () => {
    const mail = await renderMail(newContent(), envelope);
    expect(mail.headers).toEqual({
      'List-Unsubscribe': '<https://site.test/api/mail/unsubscribe?token=TOKEN>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
    expect(mail.text).toContain('不再收到这类邮件 https://site.test/unsubscribe?token=TOKEN');
    expect(mail.text).toContain('管理邮件提醒 https://site.test/mail');
    expect(mail.text).toContain('这封信由 Between Pages 自动发出。');
  });

  it('opens the one area it names, else the home page', async () => {
    const button = async (over: Parameters<typeof newContent>[0]) =>
      (await renderMail(newContent(over), envelope)).text.match(/去看看 (\S+)/)![1];
    expect(await button({})).toBe('https://site.test/days/2026-11-17');
    expect(await button({ diaryDates: ['2026-11-16', '2026-11-17'] })).toBe(
      'https://site.test/days',
    );
    expect(await button({ diaryDates: [], preview: null, sharedPages: true })).toBe(
      'https://site.test/shared-pages',
    );
    expect(await button({ diaryDates: [], preview: null, wishes: true })).toBe(
      'https://site.test/wishes',
    );
    expect(await button({ wishes: true })).toBe('https://site.test/');
  });

  it('names what changed without titles, and only the diary has a preview', async () => {
    const pages = await renderMail(
      newContent({ diaryDates: [], preview: null, sharedPages: true }),
      envelope,
    );
    expect(pages.subject).toBe('小红更新了共享页面');
    expect(pages.text).toContain('· 共享页面有更新');
    expect(pages.text).not.toContain('的日记里');
    const both = await renderMail(
      newContent({ diaryDates: [], preview: null, sharedPages: true, wishes: true }),
      envelope,
    );
    expect(both.subject).toBe('小红写了新内容');
  });

  it('cuts a preview at 50 grapheme clusters, folding whitespace, without breaking an emoji', () => {
    const family = '👨‍👩‍👧';
    const raw = `  第一行\n\n第二行 ${family.repeat(60)}`;
    const { shown, units } = previewOf(raw);
    expect(shown.startsWith('第一行 第二行 ')).toBe(true);
    expect(shown.endsWith(`${family}……`)).toBe(true);
    expect([
      ...new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(shown.slice(0, -2)),
    ]).toHaveLength(50);
    expect(raw.slice(0, units).endsWith(family)).toBe(true);
    expect(previewOf('短')).toEqual({ shown: '短', units: 1 });
  });

  it('writes dates oldest first, the month or year only when it changes', () => {
    expect(datesText(['2026-11-17', '2026-11-16'], 2026)).toBe('11 月 16 日、17 日');
    expect(datesText(['2026-10-31', '2026-11-01'], 2026)).toBe('10 月 31 日、11 月 1 日');
    expect(datesText(['2025-12-31', '2026-01-01'], 2026)).toBe(
      '2025 年 12 月 31 日、2026 年 1 月 1 日',
    );
  });

  it('names anniversaries as the home strip does, with the partner’s name', async () => {
    const subject = async (over: Partial<Extract<Mail, { category: 'anniversary' }>>) =>
      (
        await renderMail(
          {
            category: 'anniversary',
            anniversaryId: 'a1',
            kind: 'together',
            birthdayOf: null,
            name: null,
            type: 'yearly',
            years: 2,
            count: null,
            daysLeft: 3,
            partnerName: '小红',
            ...over,
          },
          envelope,
        )
      ).subject;
    expect(await subject({})).toBe('在一起 2 周年还有 3 天');
    expect(await subject({ daysLeft: 0 })).toBe('今天是在一起 2 周年');
    expect(await subject({ type: 'count', years: null, count: 1000 })).toBe(
      '在一起第 1000 天还有 3 天',
    );
    expect(
      await subject({ kind: 'birthday', birthdayOf: 'partner', years: null, daysLeft: 5 }),
    ).toBe('小红的生日还有 5 天');
    expect(await subject({ kind: 'birthday', birthdayOf: 'me', years: null, daysLeft: 1 })).toBe(
      '你的生日还有 1 天',
    );
    expect(await subject({ kind: 'other', name: '第一次见面', years: 0 })).toBe(
      '第一次见面还有 3 天',
    );
  });

  it('titles a backup mail by its reason and links to the backup page', async () => {
    const mail = await renderMail({ category: 'backup', reason: 'storage_full' }, envelope);
    expect(mail.subject).toBe('Google Drive 空间已满，备份已暂停');
    expect(mail.text).toContain('https://site.test/backup');
  });
});
