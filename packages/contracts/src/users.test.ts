import { describe, expect, it } from 'vitest';
import { DisplayName, UpdateMeRequest } from './users.ts';

const reasons = (value: string) =>
  DisplayName.safeParse(value).error?.issues.map(
    (issue) => (issue as { params?: { reason?: string } }).params?.reason,
  );

describe('DisplayName', () => {
  it('[adr:display-name#2] stores the trimmed name and counts what a person sees as one character', () => {
    expect(DisplayName.parse('  小雨 \n')).toBe('小雨');
    const couple = '👩\u200d❤️\u200d👨';
    expect(DisplayName.parse(couple + '一'.repeat(19))).toBe(couple + '一'.repeat(19));
    expect(DisplayName.parse('a' + '\u200d' + 'b')).toBe('a\u200db');
  });

  it('[adr:display-name#2] refuses empty, too long, control characters and invisible names, saying why', () => {
    expect(reasons(' \t ')).toEqual(['empty']);
    expect(reasons('一'.repeat(21))).toEqual(['long']);
    expect(reasons('小\n雨')).toEqual(['control']);
    expect(reasons('小\u2028雨')).toEqual(['control']);
    expect(reasons('\u200b\u200d')).toEqual(['invisible']);
    expect(reasons('\u200e \u200f')).toEqual(['invisible']);
  });

  it('[adr:display-name#1] takes a name and nothing that could name another user', () => {
    expect(UpdateMeRequest.parse({ displayName: ' 小雨 ' })).toEqual({ displayName: '小雨' });
    expect(
      UpdateMeRequest.safeParse({ displayName: '小雨', userId: crypto.randomUUID() }).success,
    ).toBe(false);
  });
});
