import 'fake-indexeddb/auto';
import { BODY, createDiaryDoc } from '@between-pages/collab';
import type { CommitReceipt } from '@between-pages/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  BATCH_MAX_OPERATIONS,
  BATCH_SOFT_BYTES,
  JOURNAL_SCHEMA_VERSION,
  JournalUnavailable,
  journalName,
  openJournal,
  type Journal,
} from './journal.ts';

const DIARY = '6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f';
const GENERATION = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

const open: Journal<string>[] = [];
afterEach(() => {
  for (const journal of open.splice(0)) journal.close();
});

async function journalOf(userId: string) {
  const journal = await openJournal<string>(userId);
  open.push(journal);
  return journal;
}

/** A writer whose every `type` call is one operation, the way the editor emits them. */
function writer() {
  const doc = createDiaryDoc();
  const text = doc.getText(BODY);
  return {
    doc,
    type(content: string, operationId: string = crypto.randomUUID()) {
      let update: Uint8Array = new Uint8Array();
      const capture = (u: Uint8Array) => (update = u);
      doc.once('update', capture);
      text.insert(text.length, content);
      return { operationId, update, writtenAt: new Date(), intent: content };
    },
  };
}

const textOf = (state: Uint8Array) => {
  const doc = createDiaryDoc();
  Y.applyUpdate(doc, state);
  return doc.getText(BODY).toString();
};

const empty = () => Y.encodeStateAsUpdate(createDiaryDoc());

async function setup(userId = crypto.randomUUID()) {
  const journal = await journalOf(userId);
  await journal.install({
    diaryId: DIARY,
    generationId: GENERATION,
    seq: 0,
    state: empty(),
    bindings: [],
  });
  return { journal, userId };
}

const receiptOf = (
  batch: { batchId: string; operations: { operationId: string }[] },
  seq: number,
): CommitReceipt => ({
  batchId: batch.batchId,
  operationIds: batch.operations.map((op) => op.operationId),
  generationId: GENERATION,
  seq,
  publicId: crypto.randomUUID(),
  committedAt: new Date().toISOString(),
});

describe('journal', () => {
  it('[adr:diary-collaboration-kernel#22] orders operations by one sequence shared by every tab, not by ID', async () => {
    const { journal: tab1, userId } = await setup();
    const tab2 = await journalOf(userId);
    const a = writer();
    // Descending IDs: sorting by operationId would send these backwards.
    await tab1.append(DIARY, GENERATION, a.type('一', 'ffffffff-0000-4000-8000-000000000003'));
    await tab2.append(DIARY, GENERATION, a.type('二', 'ffffffff-0000-4000-8000-000000000002'));
    await tab1.append(DIARY, GENERATION, a.type('三', 'ffffffff-0000-4000-8000-000000000001'));

    const { pending } = await tab2.load(DIARY);
    expect(pending.map((op) => [op.localSequence, op.intent])).toEqual([
      [1, '一'],
      [2, '二'],
      [3, '三'],
    ]);
  });

  it("keeps each account's operations in its own database", async () => {
    const { journal: ann } = await setup();
    await ann.append(DIARY, GENERATION, writer().type('私'));
    const bob = await journalOf(crypto.randomUUID());
    expect(await bob.load(DIARY)).toEqual({ baseline: null, pending: [], batch: null });
  });

  it('[adr:diary-collaboration-kernel#9] resends the stored batch unchanged, also after a restart', async () => {
    const { journal, userId } = await setup();
    const a = writer();
    await journal.append(DIARY, GENERATION, a.type('早'));
    await journal.append(DIARY, GENERATION, a.type('安'));
    const batch = await journal.nextBatch(DIARY);
    await journal.append(DIARY, GENERATION, a.type('！'));

    journal.close();
    const restarted = await journalOf(userId);
    expect(await restarted.nextBatch(DIARY)).toEqual(batch);
    expect(batch?.operations.map((op) => op.localSequence)).toEqual([1, 2]);
  });

  it('confirms a batch: its operations leave pending and join the baseline, later ones stay', async () => {
    const { journal } = await setup();
    const a = writer();
    await journal.append(DIARY, GENERATION, a.type('今天'));
    const batch = (await journal.nextBatch(DIARY))!;
    await journal.append(DIARY, GENERATION, a.type('下雨'));

    await journal.confirm(DIARY, receiptOf(batch, 1));

    const { baseline, pending, batch: unconfirmed } = await journal.load(DIARY);
    expect(textOf(baseline!.state)).toBe('今天');
    expect(baseline!.seq).toBe(1);
    expect(baseline!.bindings).toContainEqual({
      clientId: a.doc.clientID,
      userId: expect.any(String),
    });
    expect(pending.map((op) => op.intent)).toEqual(['下雨']);
    expect(unconfirmed).toBeNull();
    expect((await journal.nextBatch(DIARY))?.operations).toHaveLength(1);
  });

  it('keeps everything as it was when a confirmation fails', async () => {
    const { journal } = await setup();
    await journal.append(DIARY, GENERATION, writer().type('字'));
    const batch = (await journal.nextBatch(DIARY))!;
    const before = await journal.load(DIARY);

    const wrong = { ...receiptOf(batch, 1), batchId: crypto.randomUUID() };
    await expect(journal.confirm(DIARY, wrong)).rejects.toThrow();
    expect(await journal.load(DIARY)).toEqual(before);
  });

  it("does not move seq past another device's commit that has not arrived", async () => {
    const { journal } = await setup();
    const a = writer();
    const other = writer();
    await journal.append(DIARY, GENERATION, a.type('我'));
    const batch = (await journal.nextBatch(DIARY))!;
    // seq 1 is the other device's commit; this batch committed as seq 2.
    await journal.confirm(DIARY, receiptOf(batch, 2));
    expect((await journal.load(DIARY)).baseline!.seq).toBe(0);

    const seq = await journal.advance(
      DIARY,
      GENERATION,
      [{ seq: 1, delta: other.type('你').update }],
      [{ clientId: other.doc.clientID, userId: crypto.randomUUID() }],
    );
    expect(seq).toBe(2);
    const { baseline } = await journal.load(DIARY);
    expect(textOf(baseline!.state)).toHaveLength(2);
    // The broadcast of the batch itself changes nothing more.
    expect(
      await journal.advance(
        DIARY,
        GENERATION,
        [{ seq: 2, delta: batch.operations[0]!.update }],
        [],
      ),
    ).toBe(2);
  });

  it('applies committed deltas in seq order and stops at a gap', async () => {
    const { journal } = await setup();
    const other = writer();
    const one = other.type('一').update;
    const two = other.type('二').update;
    const four = other.type('四').update;
    const seq = await journal.advance(
      DIARY,
      GENERATION,
      [
        { seq: 2, delta: two },
        { seq: 1, delta: one },
        { seq: 4, delta: four },
      ],
      [],
    );
    expect(seq).toBe(2);
    expect(textOf((await journal.load(DIARY)).baseline!.state)).toBe('一二');
  });

  it('[adr:diary-collaboration-kernel#20] turns a refused batch and everything after it into drafts until the user deletes them', async () => {
    const { journal, userId } = await setup();
    const a = writer();
    await journal.append(DIARY, GENERATION, a.type('甲'));
    const batch = (await journal.nextBatch(DIARY))!;
    await journal.append(DIARY, GENERATION, a.type('乙'));

    const drafts = await journal.reject(DIARY, batch.batchId, 'rejected');
    expect(drafts.map((d) => [d.intent, d.reason])).toEqual([
      ['甲', 'rejected'],
      ['乙', 'rejected'],
    ]);
    expect(await journal.load(DIARY)).toMatchObject({ pending: [], batch: null });
    expect(await journal.nextBatch(DIARY)).toBeNull();

    journal.close();
    const reopened = await journalOf(userId);
    expect((await reopened.drafts(DIARY)).map((d) => d.intent)).toEqual(['甲', '乙']);
    await reopened.deleteDraft(drafts[0]!.draftId);
    expect((await reopened.drafts(DIARY)).map((d) => d.intent)).toEqual(['乙']);
  });

  it('keeps input of a rebuilt editor pending, and drafts whatever still builds on refused text', async () => {
    const { journal } = await setup();
    const old = writer();
    await journal.append(DIARY, GENERATION, old.type('拒'));
    const batch = (await journal.nextBatch(DIARY))!;
    const rebuilt = writer();
    await journal.append(DIARY, GENERATION, rebuilt.type('新'));
    await journal.reject(DIARY, batch.batchId, 'rejected');
    expect((await journal.load(DIARY)).pending.map((op) => op.intent)).toEqual(['新']);

    // The old editor was still on screen: its next input chains onto the refused text.
    expect(await journal.append(DIARY, GENERATION, old.type('绝'))).toBe('draft');
    let deletion: Uint8Array = new Uint8Array();
    old.doc.once('update', (u: Uint8Array) => (deletion = u));
    old.doc.getText(BODY).delete(0, 1);
    const erase = {
      operationId: crypto.randomUUID(),
      update: deletion,
      writtenAt: new Date(),
      intent: '-',
    };
    expect(await journal.append(DIARY, GENERATION, erase)).toBe('draft');
    expect((await journal.load(DIARY)).pending.map((op) => op.intent)).toEqual(['新']);
    expect((await journal.drafts(DIARY)).map((d) => d.intent)).toEqual(['拒', '绝', '-']);
  });

  it('keeps input written against an old generation as a draft instead of queueing it', async () => {
    const { journal } = await setup();
    const old = crypto.randomUUID();
    const a = writer();
    expect(await journal.append(DIARY, old, a.type('旧'))).toBe('draft');
    expect(await journal.append(DIARY, old, a.type('的'))).toBe('draft');
    expect((await journal.load(DIARY)).pending).toEqual([]);
    expect(await journal.drafts(DIARY)).toMatchObject([
      { reason: 'stale-generation', intent: '旧' },
      { reason: 'stale-generation', intent: '的' },
    ]);
  });

  it('forms batches within the soft limits and sends an oversized operation alone', async () => {
    const { journal } = await setup();
    const a = writer();
    for (let i = 0; i < BATCH_MAX_OPERATIONS + 1; i++)
      await journal.append(DIARY, GENERATION, a.type('字'));
    const first = (await journal.nextBatch(DIARY))!;
    expect(first.operations).toHaveLength(BATCH_MAX_OPERATIONS);
    await journal.confirm(DIARY, receiptOf(first, 1));

    await journal.append(DIARY, GENERATION, a.type('x'.repeat(BATCH_SOFT_BYTES)));
    await journal.append(DIARY, GENERATION, a.type('尾'));
    expect((await journal.nextBatch(DIARY))!.operations).toHaveLength(1);
  });

  it('takes a newer server state and refuses one from another generation', async () => {
    const { journal } = await setup();
    const server = writer();
    server.type('服务器上的字');
    const state = Y.encodeStateAsUpdate(server.doc);
    const bindings = [{ clientId: server.doc.clientID, userId: crypto.randomUUID() }];

    const installed = await journal.install({
      diaryId: DIARY,
      generationId: GENERATION,
      seq: 3,
      state,
      bindings,
    });
    expect(textOf(installed.state)).toBe('服务器上的字');
    expect(installed).toMatchObject({ seq: 3, bindings });
    await expect(
      journal.install({
        diaryId: DIARY,
        generationId: crypto.randomUUID(),
        seq: 9,
        state,
        bindings,
      }),
    ).rejects.toThrow();
  });

  describe('switching to a new generation', () => {
    const NEXT = '9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f';
    const reopened = (text: string, epochId?: string) => {
      const doc = createDiaryDoc();
      doc.getText(BODY).insert(0, text);
      return {
        diaryId: DIARY,
        generationId: NEXT,
        ...(epochId ? { epochId } : {}),
        seq: 0,
        state: Y.encodeStateAsUpdate(doc),
        bindings: [],
      };
    };

    it('[adr:diary-collaboration-kernel#20] [adr:diary-collaboration-kernel#21] keeps committed input as saved, makes the rest drafts and installs the new baseline at once', async () => {
      const { journal } = await setup();
      const a = writer();
      await journal.append(DIARY, GENERATION, a.type('已提交'));
      const batch = (await journal.nextBatch(DIARY))!;
      await journal.append(DIARY, GENERATION, a.type('未发送'));
      const asked: string[] = [];

      const drafts = await journal.switchTo(reopened('已提交'), async (batchId) => {
        asked.push(batchId);
        return receiptOf(batch, 1);
      });

      expect(asked).toEqual([batch.batchId]);
      expect(drafts.map((d) => [d.intent, d.reason])).toEqual([['未发送', 'stale-generation']]);
      const { baseline, pending, batch: left } = await journal.load(DIARY);
      expect(baseline).toMatchObject({ generationId: NEXT, seq: 0 });
      expect(textOf(baseline!.state)).toBe('已提交');
      expect(pending).toEqual([]);
      expect(left).toBeNull();
      // Sequence numbers keep counting, so a draft's order never repeats.
      await journal.append(DIARY, NEXT, a.type('新'));
      expect((await journal.load(DIARY)).pending[0]!.localSequence).toBe(3);
    });

    it('[adr:diary-collaboration-kernel#20] makes an unconfirmed batch a draft when the server never committed it', async () => {
      const { journal } = await setup();
      await journal.append(DIARY, GENERATION, writer().type('离线写的'));
      await journal.nextBatch(DIARY);

      const drafts = await journal.switchTo(reopened(''), async () => null);

      expect(drafts.map((d) => d.intent)).toEqual(['离线写的']);
      expect((await journal.drafts(DIARY)).map((d) => d.intent)).toEqual(['离线写的']);
    });

    it('[adr:diary-collaboration-kernel#23] starts over when the queue changed while the receipt was fetched', async () => {
      const { journal, userId } = await setup();
      const a = writer();
      await journal.append(DIARY, GENERATION, a.type('一'));
      const batch = (await journal.nextBatch(DIARY))!;
      const otherTab = await journalOf(userId);
      let calls = 0;

      const drafts = await journal.switchTo(reopened('一'), async () => {
        // The first time, another tab appends meanwhile; that switch must not install.
        if (calls++ === 0) await otherTab.append(DIARY, GENERATION, a.type('二'));
        return receiptOf(batch, 1);
      });

      expect(calls).toBe(2);
      expect(drafts.map((d) => d.intent)).toEqual(['二']);
      expect((await journal.load(DIARY)).baseline?.generationId).toBe(NEXT);
    });

    it('[adr:diary-collaboration-kernel#20] retires a frozen share: committed input saved, the rest drafts, the baseline kept', async () => {
      const { journal } = await setup();
      const a = writer();
      await journal.append(DIARY, GENERATION, a.type('冻结前'));
      const batch = (await journal.nextBatch(DIARY))!;
      await journal.append(DIARY, GENERATION, a.type('冻结后'));

      const drafts = await journal.retire(DIARY, async () => receiptOf(batch, 1));

      expect(drafts.map((d) => d.intent)).toEqual(['冻结后']);
      const { baseline, pending, batch: left } = await journal.load(DIARY);
      expect(baseline?.generationId).toBe(GENERATION);
      expect([pending, left]).toEqual([[], null]);
      expect(await journal.retire(DIARY, () => Promise.reject(new Error('not asked')))).toEqual([]);
    });

    it('changes nothing when the receipt cannot be fetched, and carries the epoch into batches', async () => {
      const { journal } = await setup();
      await journal.append(DIARY, GENERATION, writer().type('等'));
      await journal.nextBatch(DIARY);

      await expect(
        journal.switchTo(reopened(''), () => Promise.reject(new TypeError('offline'))),
      ).rejects.toThrow('offline');
      expect((await journal.load(DIARY)).baseline?.generationId).toBe(GENERATION);

      const partner = await setup();
      await partner.journal.switchTo(
        reopened('', 'e1e1e1e1-0000-4000-8000-000000000001'),
        async () => null,
      );
      await partner.journal.append(DIARY, NEXT, writer().type('搭'));
      expect(await partner.journal.nextBatch(DIARY)).toMatchObject({
        generationId: NEXT,
        epochId: 'e1e1e1e1-0000-4000-8000-000000000001',
      });
    });
  });

  it('stops writing once a newer tab upgrades the database, leaving pending in place', async () => {
    const { journal, userId } = await setup();
    await journal.append(DIARY, GENERATION, writer().type('留'));

    const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(journalName(userId), JOURNAL_SCHEMA_VERSION + 1);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const pending = await new Promise<unknown[]>((resolve) => {
      const req = upgraded.transaction('pending').objectStore('pending').getAll();
      req.onsuccess = () => resolve(req.result);
    });
    upgraded.close();

    expect(pending).toHaveLength(1);
    await expect(journal.append(DIARY, GENERATION, writer().type('新'))).rejects.toThrow(
      JournalUnavailable,
    );
  });
});
