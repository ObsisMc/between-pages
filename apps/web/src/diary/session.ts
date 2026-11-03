import type { ClientBinding, ErrorCode, ReadRange } from '@between-pages/contracts';
import * as Y from 'yjs';
import { ApiError, callApi } from '../api/client.ts';
import {
  createEditorBinding,
  type Caret,
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
import {
  createReadTracker,
  unreadSpans,
  type ReadTracker,
  type Span,
  type VisibleRun,
} from '../read-tracker/index.ts';
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
  /**
   * The own diary is in a live share, so what is saved the partner can read: as the last
   * catch-up said, until a `stopped` notice. Undefined until the server has said so.
   */
  shared?: boolean;
  /** The owner shared this diary again as this new epoch; the frozen one stays as it is. */
  reopened?: string;
  /** "只看我的文字" is on: the other person's text is hidden and nothing can be edited. */
  ownOnly: boolean;
  /** The diary's date, once the server has answered. */
  diaryDate?: string;
  /**
   * The reader's unread here (unread-and-day-page D4), once their read coverage is known:
   * `atOpen` passages when it first became known, which never changes after; `left`
   * passages now; whether one lies above or below the window. Undefined while unknown or
   * while "只看我的文字" hides the other person's text.
   */
  unread?: Unread | undefined;
};

export type Unread = { atOpen: number; left: number; above: boolean; below: boolean };

/**
 * A character the reader is looking at, as a position that follows it through edits, and
 * how far from the window's top it was (D5); `caret` when it is the focused caret's.
 */
export type ReadingPosition = { anchor: Uint8Array; top: number; caret: boolean };

export type DiarySession = {
  /** The text on screen, for copying or downloading when it cannot be stored. */
  text(): string;
  /** Deletes drafts on the user's explicit request; nothing else ever does (D7). */
  deleteDrafts(draftIds: string[]): Promise<void>;
  /**
   * "只看我的文字" (EDIT-14): a reading filter; changes no text, sends nothing. With `keep`
   * it holds its own reading position across the switch; a page holding several diaries
   * passes false and holds the position itself.
   */
  setOwnTextOnly(on: boolean, keep?: boolean): void;
  /**
   * The reading position in this diary now (D5): the caret's character when the editor has
   * focus and the caret is in the window, else the character at the window's top, or with
   * `ownOnlyNext` the first one there that stays visible under the filter. Null when this
   * diary is not at the window's top and has no caret in it, or is not laid out.
   */
  hold(ownOnlyNext?: boolean): ReadingPosition | null;
  /** Scrolls so a held position's character is as far from the window's top as it was. */
  restore(position: ReadingPosition | null): void;
  /** The character under a point of the window, by identity and author; null off the text. */
  characterAt(left: number, top: number): { client: number; clock: number; author: string } | null;
  /**
   * Brings an unread passage to about a third from the top of the window and highlights it
   * briefly (D4): the first one, or the next one after the window, else (with `wrap`) the
   * first. False when there is none to go to. Changes no text and sends nothing.
   */
  jumpToUnread(which: 'first' | 'next', wrap?: boolean): boolean;
  destroy(): void;
};

const STORE_RETRY_MS = 5_000;
const CARET_EVERY_MS = 100;

export type DiarySessionOptions = {
  place: HTMLElement;
  userId: string;
  diaryId: string;
  /** Opens the partner's shared diary as this epoch instead of the own diary (kernel D10). */
  epochId?: string | undefined;
  /** The class coloring an author's text (EDIT-13), by their slot in the space. */
  authorClass?: (author: string) => string | null;
  /** The name shown on another person's caret. */
  nameOf?: (user: string) => string;
  onChange: (state: DiaryState) => void;
  /**
   * Wraps the applying of remote commits so the reading position holds (D5). By default
   * this diary holds its own; a page with several diaries holds the one at the window's top.
   */
  keepPosition?: (apply: () => void) => void;
  /**
   * The box the diary scrolls in when it is not the window (the workspace's left page):
   * what counts as on screen is also inside it, and positions and jumps scroll it.
   */
  scroller?: HTMLElement | undefined;
};

export function createDiarySession({
  place,
  userId,
  diaryId,
  epochId,
  authorClass,
  nameOf,
  onChange,
  keepPosition,
  scroller,
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
  /** The reader's coverage once known (D4); unread is computed from it and the text. */
  let read: ReadRange[] | null = null;
  let unreadAtOpen: number | undefined;
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
      onCaret: sendCaret,
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
    (Baseline & { share?: 'live' | 'frozen'; diaryDate: string }) | 'offline' | ErrorCode
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
          diaryDate: diary.diaryDate,
        };
      }
      const { diary } = await callApi('diary', { params: { diaryId } });
      return {
        diaryId,
        generationId: diary.generationId,
        seq: diary.seq,
        state: bytes(diary.state),
        bindings: diary.bindings,
        diaryDate: diary.diaryDate,
      };
    } catch (error) {
      if (error instanceof ApiError && error.code !== 'INTERNAL') return error.code;
      // fetch rejects with a TypeError when the network is unreachable.
      return 'offline';
    }
  }

  /** What the journal keeps of a server state: everything but the share's state and the date. */
  const baselineOf = (server: Baseline & { share?: unknown; diaryDate?: string }): Baseline => {
    const baseline = { ...server };
    delete baseline.share;
    delete baseline.diaryDate;
    return baseline;
  };

  const receiptOf = async (batchId: string) =>
    (await callApi('receipt', { params: { diaryId }, query: { batchId } })).receipt;

  // The own caret goes out at most every CARET_EVERY_MS, the latest position winning (D8).
  let caretTimer: ReturnType<typeof setTimeout> | undefined;
  let caretWaiting: Caret | null | undefined;
  function sendCaret(caret: Caret | null) {
    caretWaiting = caret;
    if (caretTimer) return;
    sync?.caret(caret);
    caretWaiting = undefined;
    caretTimer = setTimeout(() => {
      caretTimer = undefined;
      if (caretWaiting !== undefined) sendCaret(caretWaiting);
    }, CARET_EVERY_MS);
  }

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
        const apply = () => {
          for (const commit of commits)
            if (arriving) arriving.push(commit.delta);
            else editor?.applyUpdate(commit.delta, authors);
        };
        // What the reader is looking at stays where it is however the text above changes (D5).
        if (arriving || !commits.length) apply();
        else (keepPosition ?? keepOwnPosition)(apply);
        updateUnread();
        // A delta the journal fails to store is fetched again by the next catch-up.
        journal?.advance(diaryId, generationId, commits, bindings).catch(() => undefined);
      },
      onStatus: (status, code) => {
        set({ sync: status });
        if (status === 'live') sender?.wake();
        // The generation changed while this device was away (kernel D7, D14).
        if (status === 'refused' && code === 'STALE_CONTEXT') void switchGeneration();
      },
      onShared: (shared) => set({ shared }),
      onCaret: (user, caret) =>
        editor?.showCaret(user, caret, {
          name: nameOf?.(user) ?? '',
          className: authorClass?.(user) ?? null,
        }),
      onContext: ({ change, generationId: next, epochId: changed }) => {
        // The partner's share: stopping freezes this view; reopening is a new epoch to open.
        if (epochId) {
          if (change === 'stopped' && changed === epochId) void switchGeneration();
          if (change === 'opened' && changed !== epochId) set({ reopened: changed });
          return;
        }
        // A diary has one live epoch at most, so any stop ends its sharing.
        if (change === 'stopped') set({ shared: false });
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
      set({ phase: 'open', diaryDate: server.diaryDate });
      return refreshDrafts();
    }
    if (typeof server === 'object') {
      set({ diaryDate: server.diaryDate, ...(server.share ? { share: server.share } : {}) });
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

  /** The part of the window the diary can be seen in: the window, or inside `scroller`. */
  const visibleArea = () => {
    const box = scroller?.getBoundingClientRect();
    return {
      top: Math.max(box?.top ?? 0, 0),
      bottom: Math.min(box?.bottom ?? window.innerHeight, window.innerHeight),
    };
  };
  const scrollDown = (by: number) => {
    if (scroller) scroller.scrollTop += by;
    else window.scrollBy(0, by);
  };

  /** Whether the editor is laid out on the page; without layout nothing can be measured. */
  const laidOut = () => {
    if (!editor || place.hidden) return false;
    const rect = place.getBoundingClientRect();
    return rect.bottom > rect.top;
  };

  /**
   * The text indexes `[from, to)` inside the window: empty at the end when the editor is
   * wholly above the window, at the start when wholly below; null without layout.
   */
  function inWindow(): Span | null {
    if (!editor || !laidOut()) return null;
    const { view } = editor;
    const length = view.state.doc.content.size - 2;
    const rect = place.getBoundingClientRect();
    const seen = visibleArea();
    const top = Math.max(rect.top, seen.top);
    const bottom = Math.min(rect.bottom, seen.bottom);
    if (rect.bottom <= seen.top) return { from: length, to: length };
    if (bottom <= top) return { from: 0, to: 0 };
    // Text index i sits at document position i + 1.
    const from = posAt(top + 1, [rect.left + 1, rect.right - 1]) ?? 1;
    const to = posAt(bottom - 1, [rect.right - 1, rect.left + 1]);
    return { from: from - 1, to: (to ?? length + 1) - 1 };
  }

  /**
   * The document position at height `top`, taken at the first of `lefts` where the editor
   * itself is under the point: a floating notice or button may cover one edge, and a point
   * off the editor would read as the end of the text. Null when neither edge shows it.
   */
  function posAt(top: number, lefts: number[]): number | null {
    if (!editor) return null;
    const { view } = editor;
    for (const left of lefts) {
      const hit = document.elementFromPoint(left, top);
      if (hit && view.dom.contains(hit)) return view.posAtCoords({ left, top })?.pos ?? null;
    }
    return null;
  }

  /**
   * The other person's characters in the part of the editor inside the window (kernel D15);
   * none while the own-text-only filter hides them, since filtering changes no unread (EDIT-14).
   */
  function onScreen(): VisibleRun[] {
    const shown = inWindow();
    if (!editor || state.ownOnly || !shown || shown.from >= shown.to) return [];
    return editor.othersCharacters(shown.from, shown.to);
  }

  /** The unread passages in text order; none until the reader's coverage is known. */
  const unreadNow = (): Span[] =>
    editor && read ? unreadSpans(editor.othersCharacters(0, Infinity), read) : [];

  /** Recomputes `state.unread` from the text, the coverage and the window (D4). */
  function updateUnread() {
    if (!read || !editor) return;
    const spans = unreadNow();
    unreadAtOpen ??= spans.length;
    if (state.ownOnly) return state.unread && set({ unread: undefined });
    const shown = inWindow();
    const next: Unread = {
      atOpen: unreadAtOpen,
      left: spans.length,
      above: !!shown && spans.some((span) => span.to <= shown.from),
      below: !!shown && spans.some((span) => span.from >= shown.to),
    };
    const was = state.unread;
    if (
      !was ||
      was.left !== next.left ||
      was.above !== next.above ||
      was.below !== next.below ||
      was.atOpen !== next.atOpen
    )
      set({ unread: next });
  }

  // Scrolling changes what is above and below the window; measured once per frame.
  let measureFrame: number | undefined;
  const onScroll = () => {
    if (measureFrame !== undefined) return;
    measureFrame = requestAnimationFrame(() => {
      measureFrame = undefined;
      updateUnread();
    });
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);
  scroller?.addEventListener('scroll', onScroll, { passive: true });

  /**
   * Picks the anchor character before the text or filter changes (D5): the caret's
   * character when the editor has focus and the caret is in the window, else the first
   * character at the window's top, moved by `keep` to one that stays visible.
   */
  function holdPosition(keep?: (index: number) => number | null): ReadingPosition | null {
    if (!editor || !laidOut()) return null;
    const { view } = editor;
    let index: number | null = null;
    let caret = false;
    const seen = visibleArea();
    if (view.hasFocus()) {
      const at = view.coordsAtPos(view.state.selection.head);
      caret = at.top >= seen.top && at.bottom <= seen.bottom;
      if (caret) index = view.state.selection.head - 1;
    }
    if (index === null) {
      const rect = place.getBoundingClientRect();
      if (rect.bottom <= seen.top || rect.top >= seen.bottom) return null;
      const top = Math.max(rect.top, seen.top);
      // Above the first line, the position is before the text: its first character.
      index = Math.max((view.posAtCoords({ left: rect.left + 1, top: top + 1 })?.pos ?? 1) - 1, 0);
    }
    if (keep) index = keep(index);
    if (index === null) return null;
    return { anchor: editor.anchorAt(index), top: view.coordsAtPos(index + 1).top, caret };
  }

  /** Scrolls so the anchor character is as far from the window's top as it was. */
  function restorePosition(held: ReadingPosition | null) {
    if (!held || !editor || !laidOut()) return;
    const index = editor.indexOfAnchor(held.anchor);
    if (index === null) return;
    const moved = editor.view.coordsAtPos(index + 1).top - held.top;
    if (moved) scrollDown(moved);
  }

  const keepOwnPosition = (apply: () => void) => {
    const held = holdPosition();
    apply();
    restorePosition(held);
  };

  const visibleUnderFilter = (index: number) => editor?.ownCharacterFrom(index) ?? null;

  open()
    .then(() => {
      if (!destroyed && state.phase === 'open')
        reads = createReadTracker({
          diaryId,
          visible: onScreen,
          onRead: (ranges) => {
            read = ranges;
            updateUnread();
          },
        });
    })
    .catch(() => set({ phase: 'failed', failure: 'INTERNAL' }));

  return {
    text: () => editor?.view.state.doc.textContent ?? '',
    setOwnTextOnly(on, keep = true) {
      // Anchored on a character that stays visible after the switch (D5).
      const held = keep ? holdPosition(on ? visibleUnderFilter : undefined) : null;
      set({ ownOnly: on });
      editor?.setOwnTextOnly(on);
      restorePosition(held);
      updateUnread();
    },
    hold: (ownOnlyNext) => holdPosition(ownOnlyNext ? visibleUnderFilter : undefined),
    restore: restorePosition,
    jumpToUnread(which, wrap = true) {
      if (!editor || state.ownOnly) return false;
      const spans = unreadNow();
      const after = inWindow()?.to ?? 0;
      const target =
        which === 'first'
          ? spans[0]
          : (spans.find((span) => span.from >= after) ?? (wrap ? spans[0] : undefined));
      if (!target) return false;
      if (laidOut()) {
        const seen = visibleArea();
        scrollDown(
          editor.view.coordsAtPos(target.from + 1).top - seen.top - (seen.bottom - seen.top) / 3,
        );
      }
      editor.flash(target.from, target.to);
      updateUnread();
      return true;
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
      clearTimeout(caretTimer);
      if (measureFrame !== undefined) cancelAnimationFrame(measureFrame);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      scroller?.removeEventListener('scroll', onScroll);
      window.removeEventListener('beforeunload', guardUnload);
      sender?.stop();
      reads?.stop();
      sync?.close();
      editor?.destroy();
      journal?.close();
    },
  };
}
