import { describe, expect, it } from 'vitest';
import { renderDay } from './render.ts';

// The Doc layout against the day page (server-backup-and-google-docs D6, invariant 15).
// Offsets are UTF-16 code units, which is what Docs indexes count.

const LOW = { id: '00000000-0000-4000-8000-000000000001', name: 'Ray' };
const HIGH = { id: 'ffffffff-0000-4000-8000-000000000002', name: 'Mo' };
const slice = (text: string, r: { start: number; end: number }) => text.slice(r.start, r.end);

describe('renderDay', () => {
  it('[adr:server-backup-and-google-docs#15] puts the date, the legend, then the own diary above the partner’s', () => {
    const doc = renderDay({
      date: '2026-10-28',
      viewer: HIGH,
      partner: LOW,
      mine: [{ author: HIGH.id, text: 'Mine.' }],
      partnerDiary: { runs: [{ author: LOW.id, text: 'Theirs.' }], frozen: false },
    });
    expect(doc.title).toBe('2026-10-28 周三');
    expect(doc.folders).toEqual(['Between Pages', '2026', '10']);
    expect(doc.text).toBe(
      '2026 年 10 月 28 日 星期三\n■ Ray   ■ Mo\nMo 的日记\nMine.\nRay 的日记\nTheirs.',
    );
    expect(doc.headings.map((h) => [slice(doc.text, h), h.level])).toEqual([
      ['2026 年 10 月 28 日 星期三', 1],
      ['Mo 的日记', 2],
      ['Ray 的日记', 2],
    ]);
  });

  it('[adr:server-backup-and-google-docs#15] colors every character by its author’s slot, as the app does', () => {
    const doc = renderDay({
      date: '2026-10-28',
      viewer: LOW,
      partner: HIGH,
      mine: [
        { author: LOW.id, text: '今天加班' },
        { author: HIGH.id, text: '🌙辛苦' },
        { author: LOW.id, text: '。\n第二行' },
      ],
      partnerDiary: null,
    });
    const byColor = (slot: 0 | 1) =>
      doc.colors
        .filter((c) => c.rgb[0] === (slot === 0 ? 0x8a / 255 : 0x2d / 255))
        .map((c) => slice(doc.text, c));
    expect(byColor(0)).toEqual(['■ Ray', '今天加班', '。\n第二行']);
    expect(byColor(1)).toEqual(['■ Mo', '🌙辛苦']);
  });

  it('[adr:server-backup-and-google-docs#5] notes a stopped share and leaves out the partner without a share', () => {
    const frozen = renderDay({
      date: '2026-10-25',
      viewer: LOW,
      partner: HIGH,
      mine: null,
      partnerDiary: { runs: [{ author: HIGH.id, text: 'Kept.' }], frozen: true },
    });
    expect(frozen.text.endsWith('Mo 的日记\nKept.\n（已停止共享）')).toBe(true);
    expect(frozen.title).toBe('2026-10-25 周日');

    const alone = renderDay({
      date: '2026-10-25',
      viewer: LOW,
      partner: null,
      mine: [{ author: LOW.id, text: 'Only me.' }],
      partnerDiary: null,
    });
    expect(alone.text).toBe('2026 年 10 月 25 日 星期日\nRay 的日记\nOnly me.');
    expect(alone.colors).toEqual([]);
  });

  it('drops control characters Docs refuses and changes the digest only with the content', () => {
    const input = {
      date: '2026-10-28',
      viewer: LOW,
      partner: null,
      mine: [{ author: LOW.id, text: 'a\u0007b\tc' }],
      partnerDiary: null,
    };
    const doc = renderDay(input);
    expect(doc.text.endsWith('ab\tc')).toBe(true);
    expect(renderDay(input).sha256).toEqual(doc.sha256);
    expect(renderDay({ ...input, mine: [{ author: LOW.id, text: 'abc!' }] }).sha256).not.toEqual(
      doc.sha256,
    );
  });
});
