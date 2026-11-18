import { describe, expect, it } from 'vitest';
import {
  deletedName,
  renderAnniversaries,
  renderGifts,
  renderPage,
  renderWishes,
  replacedName,
} from './render-together.ts';

// The `Together` Docs' layout (google-copy-beyond-diaries D4), as pure rendering.

const ann = { id: '00000000-0000-4000-8000-00000000000a', name: 'Ann' };
const bo = { id: '00000000-0000-4000-8000-00000000000b', name: 'Bo' };
const pair = { viewer: bo, partner: ann, unbound: false };

describe('render-together', () => {
  it('names an untitled page as the app does, and marks a Doc of an unbound space under its title', () => {
    const doc = renderPage({ ...pair, unbound: true, title: '  ', runs: [] });
    expect(doc.title).toBe('未命名页面');
    expect(doc.folders).toEqual(['Between Pages', 'Together', 'Shared pages']);
    expect(doc.text).toBe('未命名页面\n（已解绑，内容不再更新）\n■ Ann   ■ Bo\n');
    expect(deletedName(doc.title)).toBe('未命名页面（已在应用中删除）');
    expect(replacedName('Wishes')).toBe('Wishes（在 Google 改过，已停止更新）');
  });

  it("lists the viewer's wishes first, with hearts, the link's site and title, and the viewer's own preparing", () => {
    const wish = { want: null, link: null, preview: null, note: null, preparing: false };
    const doc = renderWishes({
      ...pair,
      mine: [],
      theirs: [
        {
          ...wish,
          authorId: ann.id,
          name: '围巾',
          want: 2,
          link: 'https://shop.example/1',
          preview: { site: '店', title: '灰围巾' },
          note: '深灰',
          preparing: true,
        },
      ],
    });
    expect(doc.title).toBe('Wishes');
    expect(doc.text).toBe(
      '心愿单\nBo 的心愿\n（还没有心愿）\nAnn 的心愿\n围巾  ♥♥  · 我在准备\nhttps://shop.example/1（店 · 灰围巾）\n备注：深灰',
    );
    expect(doc.headings.map((h) => h.level)).toEqual([1, 2, 2, 3]);
  });

  it('puts the giver’s own preparing section first and the wall newest first, with cards', () => {
    const gift = { link: null, preview: null, card: null, occasion: null };
    const doc = renderGifts({
      ...pair,
      preparing: [
        { ...gift, giverId: bo.id, receiverId: ann.id, name: '书', date: null, card: '给你' },
      ],
      wall: [
        { ...gift, giverId: ann.id, receiverId: bo.id, name: '笔', date: '2025-01-02' },
        {
          ...gift,
          giverId: bo.id,
          receiverId: ann.id,
          name: '花',
          date: '2026-10-28',
          occasion: 'Ann 的生日',
        },
      ],
    });
    expect(doc.text).toBe(
      [
        '礼物墙',
        '准备中（还没揭晓，只在你的 Drive 里）',
        '书  Bo 送给 Ann',
        '卡片（Bo 写）：给你',
        '2026 年 10 月 28 日 · Ann 的生日',
        '花  Bo 送给 Ann',
        '2025 年 1 月 2 日',
        '笔  Ann 送给 Bo',
      ].join('\n'),
    );
  });

  it('orders anniversaries by month and day, a birthday without its year by month and day only', () => {
    const doc = renderAnniversaries({
      ...pair,
      anniversaries: [
        {
          authorId: ann.id,
          kind: 'other',
          birthdayOf: null,
          name: '第一次见面',
          note: null,
          year: 2023,
          month: 9,
          day: 1,
        },
        {
          authorId: bo.id,
          kind: 'birthday',
          birthdayOf: ann.id,
          name: null,
          note: '爱吃蛋糕',
          year: null,
          month: 3,
          day: 14,
        },
      ],
    });
    expect(doc.text).toBe(
      '纪念日\nAnn 的生日  3 月 14 日\n备注：爱吃蛋糕（Bo 记的）\n第一次见面  2023 年 9 月 1 日\n（Ann 记的）',
    );
  });
});
