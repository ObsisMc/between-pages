import type { ClientBinding, ErrorCode } from '@between-pages/contracts';
import * as Y from 'yjs';
import { ApiError, callApi } from '../api/client.ts';
import {
  createEditorBinding,
  type EditIntent,
  type EditorBinding,
  type EditorOperation,
  type Refusal,
} from '../editor-binding/index.ts';
import {
  JournalUnavailable,
  openJournal,
  type Baseline,
  type Draft,
  type Journal,
} from '../journal/index.ts';
import { createSender, type SaveStatus, type Sender } from '../sender/index.ts';
import { createSyncClient, type SyncClient, type SyncStatus } from '../sync-client/index.ts';

// One open diary: the editor, the journal, the sender and the sync client wired together
// (kernel ADR D11, "界面"). The screen renders `DiaryState` and calls nothing else.

export type DiaryDraft = Draft<EditIntent[]>;

export type DiaryState = {
  phase: 'opening' | 'open' | 'failed';
  /** Why it could not open: an API code, or `offline` with nothing stored on this device. */
  failure?: ErrorCode | 'offline';
  /** The sender's status; undefined until it has reported. */
  save?: SaveStatus;
  sync?: SyncStatus;
  /** Operations shown in the editor but not yet stored on this device (D7 "本机未落盘"). */
  unstored: number;
  /** Storing on this device failed and is being retried; the text is kept in memory. */
  storeFailed: boolean;
  drafts: DiaryDraft[];
  /** The last input the editor refused, for a short notice; `count` tells repeats apart. */
  refusal?: { reason: Refusal; count: number };
};

export type DiarySession = {
  /** The text on screen, for copying or downloading when it cannot be stored. */
  text(): string;
  /** Deletes drafts on the user's explicit request; nothing else ever does (D7). */
  deleteDrafts(draftIds: string[]): Promise<void>;
  destroy(): void;
};

const STORE_RETRY_MS = 5_000;

export type DiarySessionOptions = {
  place: HTMLElement;
  userId: string;
  diaryId: string;
  onChange: (state: DiaryState) => void;
};

export function createDiarySession({
  place,
  userId,
  diaryId,
  onChange,
}: DiarySessionOptions): DiarySession {
  let state: DiaryState = { phase: 'opening', unstored: 0, storeFailed: false, drafts: [] };
  let destroyed = false;
  let journal: Journal<EditIntent[]> | undefined;
  let editor: EditorBinding | undefined;
  let sender: Sender | undefined;
  let sync: SyncClient | undefined;
  let generationId = '';
  const authors = new Map<number, string>();
  /** Operations waiting to be stored, in order; a failed one blocks the rest (D7 order). */
  const unstored: EditorOperation[] = [];
  let storing = false;
  let storeTimer: ReturnType<typeof setTimeout> | undefined;
  let remountWanted = false;
  /** Deltas that arrive while the editor is rebuilt, applied to the new one. */
  let arriving: Uint8Array[] | null = null;

  const set = (patch: Partial<DiaryState>) => {
    if (destroyed) return;
    state = { ...state, ...patch };
    onChange(state);
  };

  const bind = (bindings: ClientBinding[]) => {
    for (const { clientId, userId: author } of bindings) authors.set(clientId, author);
  };

  // Leaving with text that is not stored would lose it; the browser asks first.
  const guardUnload = (event: BeforeUnloadEvent) => {
    if (unstored.length > 0) event.preventDefault();
  };
  window.addEventListener('beforeunload', guardUnload);

  async function refreshDrafts() {
    if (!journal || destroyed) return;
    const drafts = await journal.drafts(diaryId).catch((error: unknown) => {
      if (destroyed) return null;
      throw error;
    });
    if (drafts) set({ drafts });
  }

  /** Shows the journal's state in a new editor: new clientID, empty undo (D4, D8). */
  async function mount() {
    arriving = [];
    const { baseline, pending } = await journal!.load(diaryId);
    if (destroyed || !baseline) return;
    for (const op of pending)
      for (const client of Y.parseUpdateMeta(op.update).from.keys()) authors.set(client, userId);
    bind(baseline.bindings);
    editor?.destroy();
    editor = createEditorBinding(place, {
      userId,
      onOperation: (operation) => {
        unstored.push(operation);
        set({ unstored: unstored.length });
        void store();
      },
      onRefuse: (reason) => set({ refusal: { reason, count: (state.refusal?.count ?? 0) + 1 } }),
    });
    editor.applyUpdate(baseline.state, authors);
    for (const op of pending) editor.applyUpdate(op.update, authors);
    for (const delta of arriving) editor.applyUpdate(delta, authors);
    arriving = null;
    editor.setEditable(state.save !== 'readonly' && state.save !== 'upgrade');
  }

  /** After drafts were made the editor still shows their text, so it is rebuilt, but only once
   * nothing unstored is on screen: rebuilding then would drop it. */
  async function remountWhenStored() {
    remountWanted = true;
    if (unstored.length > 0 || destroyed) return;
    remountWanted = false;
    await mount();
  }

  async function store() {
    if (storing || !journal) return;
    storing = true;
    clearTimeout(storeTimer);
    try {
      while (unstored.length > 0 && !destroyed) {
        const result = await journal.append(diaryId, generationId, unstored[0]!);
        unstored.shift();
        // Woken first, so the screen never shows "saved" while this operation waits to send.
        if (result === 'pending') sender?.wake();
        set({ unstored: unstored.length, storeFailed: false });
        if (result === 'draft') await refreshDrafts();
      }
      if (remountWanted) await remountWhenStored();
    } catch (error) {
      if (error instanceof JournalUnavailable) {
        editor?.setEditable(false);
        set({ save: 'upgrade' });
      } else {
        // Kept in memory with its ID and retried as it was (D7); the screen offers a copy.
        set({ storeFailed: true });
        storeTimer = setTimeout(() => void store(), STORE_RETRY_MS);
      }
    } finally {
      storing = false;
    }
  }

  async function serverBaseline(): Promise<Baseline | 'offline' | ErrorCode> {
    try {
      const { diary } = await callApi('diary', { params: { diaryId } });
      return {
        diaryId,
        generationId: diary.generationId,
        seq: diary.seq,
        state: Uint8Array.from(atob(diary.state), (c) => c.charCodeAt(0)),
        bindings: diary.bindings,
      };
    } catch (error) {
      if (error instanceof ApiError && error.code !== 'INTERNAL') return error.code;
      // fetch rejects with a TypeError when the network is unreachable.
      return 'offline';
    }
  }

  async function open() {
    journal = await openJournal<EditIntent[]>(userId);
    if (destroyed) return journal.close();
    const server = await serverBaseline();
    if (destroyed) return;
    let baseline = (await journal.load(diaryId)).baseline;
    if (typeof server === 'object') baseline = await journal.install(server);
    else if (server !== 'offline' || !baseline) return set({ phase: 'failed', failure: server });
    generationId = baseline.generationId;
    await mount();
    if (destroyed) return;

    sync = createSyncClient({
      diaryId,
      generationId,
      knownSeq: baseline.seq,
      onCommits: (commits, bindings) => {
        bind(bindings);
        for (const commit of commits)
          if (arriving) arriving.push(commit.delta);
          else editor?.applyUpdate(commit.delta, authors);
        // A delta the journal fails to store is fetched again by the next catch-up.
        journal?.advance(diaryId, generationId, commits, bindings).catch(() => undefined);
      },
      onStatus: (status) => {
        set({ sync: status });
        if (status === 'live') sender?.wake();
      },
    });
    sender = createSender({
      journal,
      userId,
      diaryId,
      transport: sync,
      onStatus: (save) => {
        if (save === 'readonly' || save === 'upgrade') editor?.setEditable(false);
        set({ save });
      },
      onDrafts: () => {
        void refreshDrafts();
        void remountWhenStored();
      },
    });
    set({ phase: 'open' });
    await refreshDrafts();
    sender.wake();
  }

  open().catch(() => set({ phase: 'failed', failure: 'INTERNAL' }));

  return {
    text: () => editor?.view.state.doc.textContent ?? '',
    async deleteDrafts(draftIds) {
      for (const draftId of draftIds) await journal?.deleteDraft(draftId);
      await refreshDrafts();
    },
    destroy() {
      destroyed = true;
      clearTimeout(storeTimer);
      window.removeEventListener('beforeunload', guardUnload);
      sender?.stop();
      sync?.close();
      editor?.destroy();
      journal?.close();
    },
  };
}
