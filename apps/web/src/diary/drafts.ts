import type { EditIntent } from '../editor-binding/index.ts';
import type { DiaryDraft } from './session.ts';

/** Drafts shown as one card: one refusal's run of input, deleted together. */
export type DraftGroup = {
  draftIds: string[];
  reason: DiaryDraft['reason'];
  writtenAt: Date;
  intents: EditIntent[];
};

/**
 * Groups drafts the way they were written, for display only: consecutive input with the
 * same reason is one card, and inserts typed one after another read as one passage. The
 * stored drafts stay one per operation.
 */
export function groupDrafts(drafts: DiaryDraft[]): DraftGroup[] {
  const groups: DraftGroup[] = [];
  let last: DiaryDraft | undefined;
  for (const draft of drafts) {
    const group = groups.at(-1);
    if (
      group &&
      last &&
      draft.reason === last.reason &&
      draft.generationId === last.generationId &&
      draft.localSequence === last.localSequence + 1
    ) {
      group.draftIds.push(draft.draftId);
      for (const intent of draft.intent) append(group.intents, intent);
    } else {
      groups.push({
        draftIds: [draft.draftId],
        reason: draft.reason,
        writtenAt: draft.writtenAt,
        intents: [...draft.intent],
      });
    }
    last = draft;
  }
  return groups;
}

/** Joins an insert that continues the previous one: its context before ends where that one did. */
function append(intents: EditIntent[], next: EditIntent) {
  const prev = intents.at(-1);
  if (prev?.kind === 'insert' && next.kind === 'insert' && next.before) {
    const joined = prev.before + prev.text;
    if (
      joined.endsWith(next.before) &&
      (next.before.endsWith(prev.text) || prev.text.endsWith(next.before))
    ) {
      intents[intents.length - 1] = { ...prev, text: prev.text + next.text, after: next.after };
      return;
    }
  }
  intents.push(next);
}
