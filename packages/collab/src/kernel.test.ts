import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { BODY, acceptBatch, authorRuns, buildBaseline, createDiaryDoc } from './index.ts';

// Cross-submodule behavior through the package's public surface: a generation switch
// (baseline) followed by validated edits, as the API will chain them.

const A = 'user-a';
const B = 'user-b';

function edit(doc: Y.Doc, change: (text: Y.Text) => void): Uint8Array {
  let update: Uint8Array | undefined;
  const capture = (u: Uint8Array) => (update = u);
  doc.on('update', capture);
  change(doc.getText(BODY));
  doc.off('update', capture);
  if (!update) throw new Error('the change produced no update');
  return update;
}

/** A fresh instance loaded from `state`, as every device does after a generation switch. */
function instance(state: Uint8Array, clientID: number): Y.Doc {
  const doc = createDiaryDoc();
  Y.applyUpdate(doc, state);
  doc.clientID = clientID;
  return doc;
}

function baselineOf(server: Y.Doc): Uint8Array {
  const result = buildBaseline(Y.encodeStateAsUpdate(server));
  if (!result.ok) throw new Error(`baseline failed: ${result.problem}`);
  return result.baseline;
}

const contains = (bytes: Uint8Array, needle: string) =>
  Buffer.from(bytes).includes(Buffer.from(needle));

/** UTF-16 length of all string content an encoded state carries, visible or not. */
const carriedLength = (state: Uint8Array) =>
  Y.decodeUpdate(state).structs.reduce(
    (sum, s) => sum + (s instanceof Y.Item && s.content instanceof Y.ContentString ? s.length : 0),
    0,
  );

describe('generation switch', () => {
  it('[adr:diary-collaboration-kernel#18] keeps every visible character’s ID and author in the new baseline', () => {
    const server = createDiaryDoc();
    const bindings = new Map([
      [1, A],
      [2, B],
    ]);
    const a = instance(Y.encodeStateAsUpdate(server), 1);
    const fromA = edit(a, (t) => t.insert(0, 'A 的早晨。A 的私事。'));
    acceptBatch(server, [fromA], A, bindings);
    const b = instance(Y.encodeStateAsUpdate(server), 2);
    const fromB = edit(b, (t) => t.insert(6, 'B 插话。'));
    acceptBatch(server, [fromB], B, bindings);
    Y.applyUpdate(a, fromB);
    acceptBatch(server, [edit(a, (t) => t.delete(t.length - 6, 6))], A, bindings);

    const next = instance(baselineOf(server), 3);

    expect(authorRuns(next, bindings)).toEqual(authorRuns(server, bindings));
    expect(next.getText(BODY).toString()).toBe('A 的早晨。B 插话。');
  });

  it('[adr:diary-collaboration-kernel#12] re-sent raw bytes can carry deleted private text; the accepted state and delta never do', () => {
    const SECRET = 'written-while-private';
    const server = createDiaryDoc();
    const bindings = new Map([[1, A]]);
    const old = instance(Y.encodeStateAsUpdate(server), 1);
    const privateWrite = edit(old, (t) => t.insert(0, `today ${SECRET}`));
    acceptBatch(server, [privateWrite], A, bindings);
    acceptBatch(server, [edit(old, (t) => t.delete(6, SECRET.length))], A, bindings);

    const generation = instance(baselineOf(server), 9);
    const fresh = instance(Y.encodeStateAsUpdate(generation), 4);
    const newWrite = edit(fresh, (t) => t.insert(t.length, 'shared now'));
    // An old pending copy is delivered again alongside a new edit.
    const result = acceptBatch(generation, [privateWrite, newWrite], A, bindings);

    expect(contains(privateWrite, SECRET)).toBe(true);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(contains(result.delta, SECRET)).toBe(false);
    expect(contains(Y.encodeStateAsUpdate(generation), SECRET)).toBe(false);
    expect(generation.getText(BODY).toString()).toBe('today shared now');
  });
});

// Deterministic PRNG (mulberry32) so a failing seed can be replayed.
function random(seed: number) {
  let state = seed;
  const next = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (max: number) => Math.floor(next() * max);
  return { next, int, pick: <T>(items: readonly T[]) => items[int(items.length)]! };
}

const SNIPPETS = ['日', '记', '今天', 'a', ' ', '\n', '😀', 'é', 'é', '👩‍👩‍👧', '\t'];

type Writer = { user: string; doc: Y.Doc; pending: Uint8Array[] };

describe('multi-client property', () => {
  it.each(Array.from({ length: 12 }, (_, i) => i + 1))(
    '[adr:diary-collaboration-kernel#3] [adr:diary-collaboration-kernel#5] [adr:diary-collaboration-kernel#18] seed %i: concurrent authors converge, cannot touch each other’s text, and keep authorship across baselines',
    (seed) => {
      const rng = random(seed);
      const bindings = new Map<number, string>();
      const truth = new Map<number, string>(); // which user each instance really belongs to
      let nextClient = 1;
      let server = createDiaryDoc();

      const join = (user: string, state: Uint8Array): Writer => {
        const clientID = nextClient++;
        truth.set(clientID, user);
        return { user, doc: instance(state, clientID), pending: [] };
      };
      const send = (writer: Writer, others: Writer[]) => {
        if (!writer.pending.length) return;
        const result = acceptBatch(server, writer.pending, writer.user, bindings);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        for (const id of result.claimedClientIds) bindings.set(id, writer.user);
        for (const other of others) Y.applyUpdate(other.doc, result.delta);
        writer.pending = [];
      };
      const ownRuns = (writer: Writer) =>
        authorRuns(writer.doc, truth).reduce<{ index: number; length: number; mine: boolean }[]>(
          (spans, run) => {
            const last = spans.at(-1);
            const index = last ? last.index + last.length : 0;
            spans.push({ index, length: run.text.length, mine: run.author === writer.user });
            return spans;
          },
          [],
        );

      for (let round = 0; round < 4; round++) {
        const start = Y.encodeStateAsUpdate(server);
        const writers = [join(A, start), join(B, start)];

        for (let step = 0; step < 40; step++) {
          const writer = rng.pick(writers);
          const text = writer.doc.getText(BODY);
          const spans = ownRuns(writer);
          const own = spans.filter((span) => span.mine);
          const foreign = spans.filter((span) => !span.mine);
          const roll = rng.next();

          if (roll < 0.5 || !own.length) {
            let index = rng.int(text.length + 1);
            const before = text.toString().charCodeAt(index - 1);
            if (before >= 0xd800 && before <= 0xdbff) index++; // never split a surrogate pair
            writer.pending.push(edit(writer.doc, (t) => t.insert(index, rng.pick(SNIPPETS))));
          } else if (roll < 0.75) {
            const span = rng.pick(own);
            writer.pending.push(edit(writer.doc, (t) => t.delete(span.index, span.length)));
          } else if (roll < 0.85 && foreign.length) {
            // Attack from a throwaway copy, so neither the writer nor the server keeps it.
            const span = rng.pick(foreign);
            const copy = instance(Y.encodeStateAsUpdate(writer.doc), writer.doc.clientID);
            const attack = edit(copy, (t) => t.delete(span.index, 1));
            const probe = instance(Y.encodeStateAsUpdate(server), 0);
            expect(acceptBatch(probe, [attack], writer.user, bindings)).toMatchObject({
              ok: false,
              reason: 'FOREIGN_DELETE',
            });
          } else {
            send(
              writer,
              writers.filter((other) => other !== writer),
            );
          }
        }
        for (const writer of writers)
          send(
            writer,
            writers.filter((other) => other !== writer),
          );

        const body = server.getText(BODY).toString();
        for (const writer of writers) expect(writer.doc.getText(BODY).toString()).toBe(body);

        const baseline = baselineOf(server);
        expect(carriedLength(baseline)).toBe(body.length);
        const next = instance(baseline, 0);
        expect(authorRuns(next, bindings)).toEqual(authorRuns(server, bindings));
        for (const run of authorRuns(server, bindings))
          expect(run.author).toBe(truth.get(run.client));
        server = instance(baseline, 0);
      }
    },
  );
});
