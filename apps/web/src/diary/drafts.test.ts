import { describe, expect, it } from 'vitest';
import { groupDrafts } from './drafts.ts';
import type { DiaryDraft } from './session.ts';

const GENERATION = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
let sequence = 0;
const draft = (intent: DiaryDraft['intent'], patch: Partial<DiaryDraft> = {}): DiaryDraft => ({
  draftId: crypto.randomUUID(),
  diaryId: '7c1d2b8e-3f4a-4b5c-8d6e-9f0a1b2c3d4e',
  generationId: GENERATION,
  reason: 'rejected',
  savedAt: new Date(),
  localSequence: ++sequence,
  operationId: crypto.randomUUID(),
  writtenAt: new Date('2026-10-27T08:00:00Z'),
  intent,
  ...patch,
});

describe('groupDrafts', () => {
  it('shows text typed one character at a time as one passage', () => {
    const groups = groupDrafts([
      draft([{ kind: 'insert', text: '被', before: '今天', after: '' }]),
      draft([{ kind: 'insert', text: '拒', before: '今天被', after: '' }]),
      draft([{ kind: 'insert', text: '了', before: '今天被拒', after: '。' }]),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.draftIds).toHaveLength(3);
    expect(groups[0]!.intents).toEqual([
      { kind: 'insert', text: '被拒了', before: '今天', after: '。' },
    ]);
  });

  it('keeps input elsewhere, other kinds and separate refusals apart', () => {
    const groups = groupDrafts([
      draft([{ kind: 'insert', text: '甲', before: '开头', after: '' }]),
      draft([{ kind: 'insert', text: '乙', before: '别处', after: '' }]),
      draft([{ kind: 'delete', text: '丙', before: '别处乙', after: '' }]),
      draft([{ kind: 'insert', text: '丁', before: '', after: '' }], { localSequence: 99 }),
    ]);
    expect(groups.map((g) => g.intents.map((i) => i.kind))).toEqual([
      ['insert', 'insert', 'delete'],
      ['insert'],
    ]);
  });
});
