import { createHash } from 'node:crypto';
import type { DocBody } from '../google/docs.ts';
import { ROOT_FOLDER } from '../store/copy.ts';
import { SLOT_COLORS, clean, type CopyPerson, type CopyRun } from './render.ts';

// The `Together` Docs (google-copy-beyond-diaries D4): one per shared page and three
// summaries, laid out as the app shows them, each rendered whole from the state the viewer
// can read (D6). Pure: what goes in is already filtered for the viewer, so a gift in
// preparation reaches only the giver's input (D3). Colors follow the space's slots, as on
// the day Doc.

export const TOGETHER_FOLDER = 'Together';
export const PAGES_FOLDER = 'Shared pages';
/** The app's placeholder for a page without a title. */
export const UNTITLED = '未命名页面';
/** Under the heading of every `Together` Doc once the space is unbound (D7). */
export const UNBOUND_LINE = '（已解绑，内容不再更新）';
export const PREPARING_HEADING = '准备中（还没揭晓，只在你的 Drive 里）';

export type TogetherDoc = DocBody & {
  /** The Drive file name: the page title, or `Wishes`, `Gifts`, `Anniversaries`. */
  title: string;
  folders: readonly string[];
  /** Of everything above; an unchanged Doc is not written again (D6). */
  sha256: Uint8Array;
};

type Common = { viewer: CopyPerson; partner: CopyPerson; unbound: boolean };

export type PageCopyInput = Common & { title: string; runs: CopyRun[] };

export type WishEntry = {
  authorId: string;
  name: string;
  want: number | null;
  link: string | null;
  preview: { title: string | null; site: string | null } | null;
  note: string | null;
  /** The viewer's own "我在准备" on a wish of the partner. */
  preparing: boolean;
};
export type WishesCopyInput = Common & { mine: WishEntry[]; theirs: WishEntry[] };

export type GiftEntry = {
  giverId: string;
  receiverId: string;
  name: string;
  link: string | null;
  preview: { title: string | null; site: string | null } | null;
  date: string | null;
  /** The occasion as the app names it, an anniversary's current name included. */
  occasion: string | null;
  card: string | null;
};
export type GiftsCopyInput = Common & { preparing: GiftEntry[]; wall: GiftEntry[] };

export type AnniversaryEntry = {
  authorId: string;
  kind: 'birthday' | 'together' | 'other';
  birthdayOf: string | null;
  name: string | null;
  note: string | null;
  year: number | null;
  month: number;
  day: number;
};
export type AnniversariesCopyInput = Common & { anniversaries: AnniversaryEntry[] };

const pageName = (title: string) => title.trim() || UNTITLED;

/** The name a summary changed in Google keeps once a new one carries on (D6). */
export const replacedName = (name: string) => `${name}（在 Google 改过，已停止更新）`;
/** The name a page's Doc takes once the page is deleted in the app (D7). */
export const deletedName = (name: string) => `${name}（已在应用中删除）`;

/** Builds one Doc: plain text with heading ranges and author colors, as `renderDay`. */
function builder(input: Common) {
  const pair = [input.viewer, input.partner].sort((a, b) => (a.id < b.id ? -1 : 1));
  const people = new Map(pair.map((p) => [p.id, p]));
  let text = '';
  const headings: DocBody['headings'] = [];
  const colors: DocBody['colors'] = [];
  const colorOf = (author: string) => {
    const slot = pair.findIndex((p) => p.id === author);
    return slot < 0 ? null : SLOT_COLORS[slot]!;
  };
  const b = {
    nameOf: (id: string) => people.get(id)?.name ?? '',
    line(content: string, heading?: 1 | 2 | 3, author?: string) {
      if (text) text += '\n';
      const part = clean(content);
      if (heading)
        headings.push({ start: text.length, end: text.length + part.length, level: heading });
      if (author) b.colored(part, author);
      else text += part;
    },
    colored(part: string, author: string) {
      const rgb = colorOf(author);
      if (rgb && part) colors.push({ start: text.length, end: text.length + part.length, rgb });
      text += part;
    },
    heading(title: string) {
      b.line(title, 1);
      if (input.unbound) b.line(UNBOUND_LINE);
    },
    legend() {
      b.line('');
      pair.forEach((person, i) => {
        if (i) text += '   ';
        b.colored(`■ ${person.name}`, person.id);
      });
    },
    done(title: string, folders: readonly string[]): TogetherDoc {
      const sha256 = new Uint8Array(
        createHash('sha256')
          .update(JSON.stringify({ title, folders, text, headings, colors }))
          .digest(),
      );
      return { title, folders, text, headings, colors, sha256 };
    },
  };
  return b;
}

const linkLine = (link: string | null, preview: WishEntry['preview']) => {
  if (!link) return null;
  const about = [preview?.site, preview?.title].filter((p): p is string => !!p);
  return about.length ? `${link}（${about.join(' · ')}）` : link;
};

/** "2024 年 5 月 20 日", or "3 月 14 日" for a birthday without its year. */
const dateText = (year: number | null, month: number, day: number) =>
  `${year === null ? '' : `${year} 年 `}${month} 月 ${day} 日`;

const isoDateText = (date: string) => {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return dateText(y, m, d);
};

/** A shared page: its title, the legend and the whole text in its authors' colors (D4). */
export function renderPage(input: PageCopyInput): TogetherDoc {
  const b = builder(input);
  const name = pageName(input.title);
  b.heading(name);
  b.legend();
  b.line('');
  for (const run of input.runs) b.colored(clean(run.text), run.author);
  return b.done(name, [ROOT_FOLDER, TOGETHER_FOLDER, PAGES_FOLDER]);
}

/** Both wish lists, the viewer's first; the viewer's own "我在准备" marked (D3, D4). */
export function renderWishes(input: WishesCopyInput): TogetherDoc {
  const b = builder(input);
  b.heading('心愿单');
  const list = (owner: CopyPerson, wishes: WishEntry[]) => {
    b.line(`${owner.name} 的心愿`, 2);
    if (!wishes.length) b.line('（还没有心愿）');
    for (const wish of wishes) {
      const hearts = wish.want ? `  ${'♥'.repeat(wish.want)}` : '';
      b.line(`${wish.name}${hearts}${wish.preparing ? '  · 我在准备' : ''}`, 3, wish.authorId);
      const link = linkLine(wish.link, wish.preview);
      if (link) b.line(link);
      if (wish.note) b.line(`备注：${wish.note}`, undefined, wish.authorId);
    }
  };
  list(input.viewer, input.mine);
  list(input.partner, input.theirs);
  return b.done('Wishes', [ROOT_FOLDER, TOGETHER_FOLDER]);
}

/** The gift wall newest first; the giver's own gifts in preparation in a section above (D3). */
export function renderGifts(input: GiftsCopyInput): TogetherDoc {
  const b = builder(input);
  b.heading('礼物墙');
  const gift = (g: GiftEntry, heading: 2 | 3) => {
    const when = [g.date && isoDateText(g.date), g.occasion].filter(Boolean).join(' · ');
    if (heading === 2) b.line(when || '没有日期', 2);
    b.line(
      `${g.name}  ${b.nameOf(g.giverId)} 送给 ${b.nameOf(g.receiverId)}`,
      heading === 3 ? 3 : undefined,
    );
    const link = linkLine(g.link, g.preview);
    if (link) b.line(link);
    if (g.card) b.line(`卡片（${b.nameOf(g.giverId)} 写）：${g.card}`, undefined, g.giverId);
  };
  if (input.preparing.length) {
    b.line(PREPARING_HEADING, 2);
    for (const g of input.preparing) gift(g, 3);
  }
  if (!input.wall.length) b.line('（礼物墙上还没有礼物）');
  const wall = [...input.wall].sort((x, y) => (y.date ?? '').localeCompare(x.date ?? ''));
  for (const g of wall) gift(g, 2);
  return b.done('Gifts', [ROOT_FOLDER, TOGETHER_FOLDER]);
}

/** Every anniversary by month and day, with its note and who recorded it (D4). */
export function renderAnniversaries(input: AnniversariesCopyInput): TogetherDoc {
  const b = builder(input);
  b.heading('纪念日');
  if (!input.anniversaries.length) b.line('（还没有纪念日）');
  const sorted = [...input.anniversaries].sort((x, y) => x.month - y.month || x.day - y.day);
  for (const a of sorted) {
    const label =
      a.kind === 'together'
        ? '在一起的日子'
        : a.kind === 'birthday'
          ? `${b.nameOf(a.birthdayOf!)} 的生日`
          : a.name!;
    b.line(`${label}  ${dateText(a.year, a.month, a.day)}`, 2, a.authorId);
    const by = `（${b.nameOf(a.authorId)} 记的）`;
    b.line(a.note ? `备注：${a.note}${by}` : by, undefined, a.authorId);
  }
  return b.done('Anniversaries', [ROOT_FOLDER, TOGETHER_FOLDER]);
}
