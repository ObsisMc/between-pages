import { createHash } from 'node:crypto';
import type { DocBody } from '../google/docs.ts';
import { ROOT_FOLDER } from '../store/copy.ts';

// One day's Doc as the day page shows it (server-backup-and-google-docs D6, invariant 15):
// the date, the author legend, the viewer's own diary above the partner's, each character in
// its author's color. Colors follow the space's slots, the pair's user IDs in sort order, as
// the web app's `--author-1` and `--author-2` in its light theme.

export type CopyPerson = { id: string; name: string };
export type CopyRun = { author: string; text: string };

export type DayCopyInput = {
  date: string;
  viewer: CopyPerson;
  partner: CopyPerson | null;
  mine: CopyRun[] | null;
  partnerDiary: { runs: CopyRun[]; frozen: boolean } | null;
};

export type DayDoc = DocBody & {
  /** `YYYY-MM-DD 周X`: names sort by date. */
  title: string;
  /** `Between Pages / 2026 / 10`. */
  folders: readonly [string, string, string];
  /** Of everything above; an unchanged Doc is not written again (D7). */
  sha256: Uint8Array;
};

const SLOT_COLORS = [
  [0x8a / 255, 0x4a / 255, 0x2b / 255],
  [0x2d / 255, 0x5e / 255, 0x66 / 255],
] as const;
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

// Docs refuses control characters other than newline and tab in inserted text.
// eslint-disable-next-line no-control-regex
const clean = (text: string) => text.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '');

const weekdayOf = (date: string) => WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()]!;

/** The Doc's name: `YYYY-MM-DD 周X`, so names sort by date. */
export const dayTitle = (date: string) => `${date} 周${weekdayOf(date)}`;

/** The name a Doc changed in Google keeps once a new one carries on (D8). */
export const replacedTitle = (date: string) => `${dayTitle(date)}（在 Google 改过，已停止更新）`;

export function renderDay(input: DayCopyInput): DayDoc {
  const [year, month, day] = input.date.split('-') as [string, string, string];
  const weekday = weekdayOf(input.date);
  const pair = input.partner
    ? [input.viewer, input.partner].sort((a, b) => (a.id < b.id ? -1 : 1))
    : [];
  const colorOf = (author: string) => {
    const slot = pair.findIndex((p) => p.id === author);
    return slot < 0 ? null : SLOT_COLORS[slot]!;
  };

  let text = '';
  const headings: DayDoc['headings'] = [];
  const colors: DayDoc['colors'] = [];
  const line = (content: string, heading?: 1 | 2) => {
    if (text) text += '\n';
    if (heading)
      headings.push({ start: text.length, end: text.length + content.length, level: heading });
    text += content;
  };
  const colored = (part: string, author: string) => {
    const rgb = colorOf(author);
    if (rgb && part) colors.push({ start: text.length, end: text.length + part.length, rgb });
    text += part;
  };
  const diary = (owner: CopyPerson, runs: CopyRun[]) => {
    line(`${owner.name} 的日记`, 2);
    text += '\n';
    for (const run of runs) colored(clean(run.text), run.author);
  };

  line(`${Number(year)} 年 ${Number(month)} 月 ${Number(day)} 日 星期${weekday}`, 1);
  if (pair.length) {
    text += '\n';
    pair.forEach((person, i) => {
      if (i) text += '   ';
      colored(`■ ${person.name}`, person.id);
    });
  }
  if (input.mine) diary(input.viewer, input.mine);
  if (input.partnerDiary && input.partner) {
    diary(input.partner, input.partnerDiary.runs);
    if (input.partnerDiary.frozen) line('（已停止共享）');
  }

  const title = dayTitle(input.date);
  const folders = [ROOT_FOLDER, year, month] as const;
  const sha256 = new Uint8Array(
    createHash('sha256')
      .update(JSON.stringify({ title, folders, text, headings, colors }))
      .digest(),
  );
  return { title, folders, text, headings, colors, sha256 };
}
