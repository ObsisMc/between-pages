# Spike: standard Yjs updates with server-side author checks

Status: exploratory spike (2026-10-24), not part of the validated prototypes and not wired into the browser suite.

Question: can clients send ordinary Yjs updates (the off-the-shelf model used by y-prosemirror / Hocuspocus / Tiptap) while the server still enforces "only delete your own characters"?

## How the check works

`authority.mjs` binds each Yjs `clientID` to an authenticated user on first use. Every Yjs item ID carries its creator's clientID, so for each incoming update (decoded with the public `Y.decodeUpdate`) the server checks:

- new items use only the sender's clientIDs, contain only allowed content, and set no attributes;
- every range in the delete set belongs to the sender's clientIDs;
- every referenced origin / parent / deleted range already exists, so nothing is left pending.

It reads `Item` fields (`origin`, `rightOrigin`, `parent`, `parentSub`, `content`) that Yjs does not document as stable API.

## Findings

Run `node explore.mjs`, `node explore-text.mjs` and `node perf.mjs` from this directory.

- **y-prosemirror's diff (`updateYFragment`) breaks author protection on line breaks.** Pressing Enter (paragraph schema) or inserting a hard break inside the other person's text is encoded as "delete the tail of their text node and re-create it", so the server correctly rejects it as a foreign delete. Joining the other person's paragraphs fails the same way. Inserting plain text, newlines at the end of their text, and concurrent edits all pass.
- **Forbidding line breaks inside the other person's text is not enough** (`node explore-rules.mjs`). y-prosemirror turns each edit into a plain string diff (`simpleDiff` without a cursor hint), so with repeated characters it picks the wrong item: A deleting her own "哈" before B's "哈哈" is sent as deleting B's last "哈" (rejected), and B inserting "好" before A's "好" lands after it. A concurrent split also moves A's inserted character into the wrong paragraph, because a split is encoded as delete + re-create. Joining your own paragraph is rejected once it contains the other person's insertion.
- **A single `Y.Text` with `\n` as an ordinary character passes every scenario**: a newline inside the other person's text, deleting your own newline, foreign deletes rejected, and personal `Y.UndoManager` undo/redo that leaves the other person's inserted text in place. This needs a small custom ProseMirror ↔ `Y.Text` binding instead of y-prosemirror.
- **After a rejection the client has diverged.** Its later updates depend on the rejected items and fail as `MISSING_DEPENDENCY`; the client must reset to server state and keep its text as a recovery draft.
- **Cost is negligible.** On a fragmented 100k-character document (≈9.9k items), server check p95 ≈ 0.013 ms and apply p95 ≈ 0.05 ms per keystroke; the state is ≈ 4.7 bytes per character (mostly CJK UTF-8).

Not covered: the full `ySyncPlugin` with an `EditorView`, Hocuspocus integration, PG persistence and commit acks, IndexedDB, browsers, and timestamps / unread metadata per item range.
