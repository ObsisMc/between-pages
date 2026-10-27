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
import { createReadTracker, type ReadTracker, type VisibleRun } from '../read-tracker/index.ts';
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
  /** Committed deltas applied so far; a history preview compares it to say text changed. */
  remoteChanges: number;
  /** The last input the editor refused, for a short notice; `count` tells repeats apart. */
  refusal?: { reason: Refusal; count: number };
  /** The partner's view of a shared diary: `live` writes the own text, `frozen` is read-only. */
  share?: 'live' | 'frozen';
  /** The owner shared this diary again as this new epoch; the frozen one stays as it is. */
  reopened?: string;
  /** "只看我的文字" is on: the other person's text is hidden and nothing can be edited. */
  ownOnly: boolean;
};

export type DiarySession = {
  /** The text on screen, for copying or downloading when it cannot be stored. */
  text(): string;
  /** Deletes drafts on the user's explicit request; nothing else ever does (D7). */
  deleteDrafts(draftIds: string[]): Promise<void>;
  /** "只看我的文字" (EDIT-14): a reading filter; changes no text, sends nothing. */
  setOwnTextOnly(on: boolean): void;
  /** The character under a point of the window, by identity and author; null off the text. */
  characterAt(left: number, top: number): { client: number; clock: number; author: string } | null;
  destroy(): void;
};

const STORE_RETRY_MS = 5_000;

export type DiarySessionOptions = {
  place: HTMLElement;
  userId: string;
  diaryId: string;
  /** Opens the partner's shared diary as this epoch instead of the own diary (kernel D10). */
  epochId?: string | undefined;
  /** The class coloring an author's text (EDIT-13), by their slot in the space. */
  authorClass?: (author: string) => string | null;
  onChange: (state: DiaryState) => void;
};

export function createDiarySession({
  place,
  userId,
  diaryId,
  epochId,
  authorClass,
  onChange,
}: DiarySessionOptions): DiarySession {
  let state: DiaryState = {
    phase: 'opening',
    ownOnly: false,
    unstored: 0,
    storeFailed: false,
    drafts: [],
    remoteChanges: 0,
  };
  let destroyed = false;
  let journal: Journal<EditIntent[]> | undefined;
  let editor: EditorBinding | undefined;
  let sender: Sender | undefined;
  let sync: SyncClient | undefined;
  let reads: ReadTracker | undefined;
  let generationId = '';
  const authors = new Map<number, string>();
  /** Operations waiting to be stored, in order; a failed one blocks the rest (D7 order). */
  const unstored: EditorOperation[] = [];
  let storing = false;
  let storeTimer: ReturnType<typeof setTimeout> | undefined;
  let remountWanted = false;
  /** A generation switch waits for text on screen to be stored first. */
  let switchWanted = false;
  let switching = false;
  let switchTimer: ReturnType<typeof setTimeout> | undefined;
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
  function newEditor() {
    editor?.destroy();
    editor = createEditorBinding(place, {
      userId,
      ...(authorClass ? { authorClass } : {}),
      onOperation: (operation) => {
        unstored.push(operation);
        set({ unstored: unstored.length });
        void store();
      },
      onRefuse: (reason) => set({ refusal: { reason, count: (state.refusal?.count ?? 0) + 1 } }),
    });
    if (state.ownOnly) editor.setOwnTextOnly(true);
    return editor;
  }

  async function mount() {
    arriving = [];
    const { baseline, pending } = await journal!.load(diaryId);
    if (destroyed || !baseline) return;
    for (const op of pending)
      for (const client of Y.parseUpdateMeta(op.update).from.keys()) authors.set(client, userId);
    bind(baseline.bindings);
    const editor = newEditor();
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
      if (switchWanted && unstored.length === 0) {
        switchWanted = false;
        void switchGeneration();
      }
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

  /** A frozen share as its partner may read it: shown read-only, never written to the journal. */
  function mountFrozen(view: Baseline) {
    sender?.stop();
    sync?.close();
    sender = undefined;
    sync = undefined;
    arriving = null;
    bind(view.bindings);
    const editor = newEditor();
    editor.applyUpdate(view.state, authors);
    editor.setEditable(false);
    set({ share: 'frozen', save: 'saved' });
  }

  /** The current state from the server: the own diary, or the partner's epoch and whether it is live. */
  async function serverBaseline(): Promise<
    (Baseline & { share?: 'live' | 'frozen' }) | 'offline' | ErrorCode
  > {
    const bytes = (state: string) => Uint8Array.from(atob(state), (c) => c.charCodeAt(0));
    try {
      if (epochId) {
        const { diary } = await callApi('sharedDiary', { params: { diaryId, epochId } });
        return {
          diaryId,
          generationId: diary.generationId,
          // Only a live share has input of its own to send.
          ...(diary.share === 'live' ? { epochId } : {}),
          seq: diary.seq,
          state: bytes(diary.state),
          bindings: diary.bindings,
          share: diary.share,
        };
      }
      const { diary } = await callApi('diary', { params: { diaryId } });
      return {
        diaryId,
        generationId: diary.generationId,
        seq: diary.seq,
        state: bytes(diary.state),
        bindings: diary.bindings,
      };
    } catch (error) {
      if (error instanceof ApiError && error.code !== 'INTERNAL') return error.code;
      // fetch rejects with a TypeError when the network is unreachable.
      return 'offline';
    }
  }

  /** What the journal keeps of a server state: everything but the share's state. */
  const baselineOf = (server: Baseline & { share?: unknown }): Baseline => {
    const baseline = { ...server };
    delete baseline.share;
    return baseline;
  };

  const receiptOf = async (batchId: string) =>
    (await callApi('receipt', { params: { diaryId }, query: { batchId } })).receipt;

  /** The sync client and sender of the current generation. */
  function connect(seq: number) {
    sync = createSyncClient({
      diaryId,
      generationId,
      ...(state.share === 'live' && epochId ? { epochId } : {}),
      knownSeq: seq,
      onCommits: (commits, bindings) => {
        bind(bindings);
        if (commits.length > 0) set({ remoteChanges: state.remoteChanges + commits.length });
        for (const commit of commits)
          if (arriving) arriving.push(commit.delta);
          else editor?.applyUpdate(commit.delta, authors);
        // A delta the journal fails to store is fetched again by the next catch-up.
        journal?.advance(diaryId, generationId, commits, bindings).catch(() => undefined);
      },
      onStatus: (status, code) => {
        set({ sync: status });
        if (status === 'live') sender?.wake();
        // The generation changed while this device was away (kernel D7, D14).
        if (status === 'refused' && code === 'STALE_CONTEXT') void switchGeneration();
      },
      onContext: ({ change, generationId: next, epochId: changed }) => {
        // The partner's share: stopping freezes this view; reopening is a new epoch to open.
        if (epochId) {
          if (change === 'stopped' && changed === epochId) void switchGeneration();
          if (change === 'opened' && changed !== epochId) set({ reopened: changed });
          return;
        }
        if (change === 'opened' && next !== generationId) void switchGeneration();
      },
    });
    sender = createSender({
      journal: journal!,
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
  }

  /**
   * Moves this screen to the diary's new generation (kernel D4, D7, D8): no new input
   * meanwhile, everything shown is stored first, the journal reconciles pending input by
   * receipt and installs the clean baseline, and a new editor (new clientID, empty undo)
   * loads it. If the server cannot be reached, nothing changes and it is tried again.
   */
  async function switchGeneration() {
    if (switching || destroyed || !journal) return;
    // Text on screen but not stored would be lost by the new editor (invariant 23).
    if (unstored.length > 0) {
      switchWanted = true;
      return;
    }
    switching = true;
    editor?.setEditable(false);
    sender?.stop();
    sync?.close();
    try {
      const server = await serverBaseline();
      if (destroyed) return;
      if (typeof server !== 'object') {
        if (server !== 'offline') return set({ phase: 'failed', failure: server });
        switchTimer = setTimeout(() => void switchGeneration(), STORE_RETRY_MS);
        return;
      }
      if (server.share === 'frozen') {
        // The share froze: input not committed before it stays only as drafts (invariant 20).
        await journal.retire(diaryId, receiptOf);
        mountFrozen(server);
        return await refreshDrafts();
      }
      await journal.switchTo(baselineOf(server), receiptOf);
      const { baseline } = await journal.load(diaryId);
      if (destroyed || !baseline) return;
      generationId = baseline.generationId;
      await mount();
      connect(baseline.seq);
      await refreshDrafts();
      sender?.wake();
    } catch {
      // A receipt that could not be fetched: the journal is unchanged; try again later.
      if (!destroyed) switchTimer = setTimeout(() => void switchGeneration(), STORE_RETRY_MS);
    } finally {
      switching = false;
    }
  }

  async function open() {
    journal = await openJournal<EditIntent[]>(userId);
    if (destroyed) return journal.close();
    const server = await serverBaseline();
    if (destroyed) return;
    if (typeof server === 'object' && server.share === 'frozen') {
      await journal.retire(diaryId, receiptOf).catch(() => undefined);
      mountFrozen(server);
      set({ phase: 'open' });
      return refreshDrafts();
    }
    if (typeof server === 'object') {
      if (server.share) set({ share: server.share });
      await journal.switchTo(baselineOf(server), receiptOf);
    } else if (server !== 'offline') return set({ phase: 'failed', failure: server });
    const { baseline } = await journal.load(diaryId);
    if (!baseline) return set({ phase: 'failed', failure: 'offline' });
    generationId = baseline.generationId;
    await mount();
    if (destroyed) return;
    connect(baseline.seq);
    set({ phase: 'open' });
    await refreshDrafts();
    sender?.wake();
  }

  /** The other person's characters in the part of the editor inside the window (kernel D15). */
  function onScreen(): VisibleRun[] {
    if (!editor || place.hidden) return [];
    const rect = place.getBoundingClientRect();
    const top = Math.max(rect.top, 0);
    const bottom = Math.min(rect.bottom, window.innerHeight);
    if (bottom <= top) return [];
    const { view } = editor;
    // Text index i sits at document position i + 1.
    const from = view.posAtCoords({ left: rect.left + 1, top: top + 1 })?.pos ?? 1;
    const to = view.posAtCoords({ left: rect.right - 1, top: bottom - 1 })?.pos;
    return editor.othersCharacters(from - 1, (to ?? view.state.doc.content.size) - 1);
  }

  open()
    .then(() => {
      if (!destroyed && state.phase === 'open')
        reads = createReadTracker({ diaryId, visible: onScreen });
    })
    .catch(() => set({ phase: 'failed', failure: 'INTERNAL' }));

  return {
    text: () => editor?.view.state.doc.textContent ?? '',
    setOwnTextOnly(on) {
      set({ ownOnly: on });
      editor?.setOwnTextOnly(on);
    },
    characterAt(left, top) {
      if (!editor) return null;
      const { view } = editor;
      const pos = view.posAtCoords({ left, top });
      if (!pos) return null;
      // A boundary is returned; left of it means the character before was hit.
      const index = pos.pos - 1;
      const hitBefore = index > 0 && left < view.coordsAtPos(pos.pos).left;
      return editor.characterAt(hitBefore ? index - 1 : index);
    },
    async deleteDrafts(draftIds) {
      for (const draftId of draftIds) await journal?.deleteDraft(draftId);
      await refreshDrafts();
    },
    destroy() {
      destroyed = true;
      clearTimeout(storeTimer);
      clearTimeout(switchTimer);
      window.removeEventListener('beforeunload', guardUnload);
      sender?.stop();
      reads?.stop();
      sync?.close();
      editor?.destroy();
      journal?.close();
    },
  };
}
