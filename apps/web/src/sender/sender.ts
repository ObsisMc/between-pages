import { errorCategory, type CommitReceipt, type ErrorCode } from '@between-pages/contracts';
import { JournalUnavailable, type Draft, type Journal, type SendBatch } from '../journal/index.ts';

// Sends one diary's journal to the server in batches (kernel ADR D13): one batch in flight
// per account and diary across tabs, held by a Web Lock; the next batch is formed only
// after the previous one is confirmed in the journal, and a batch is resent unchanged.

/** What became of one submit. `offline`: no answer arrived, so it may or may not have committed. */
export type SubmitResult =
  | { type: 'ack'; receipt: CommitReceipt }
  | { type: 'error'; code: ErrorCode }
  | { type: 'offline' };

/** The network as the sender needs it; the sync client provides it. */
export type SyncTransport = {
  submit(batch: SendBatch): Promise<SubmitResult>;
  /** The receipt of a committed batch, null when none is committed; throws when unreachable. */
  receipt(diaryId: string, batchId: string): Promise<CommitReceipt | null>;
};

/**
 * The sync states the diary screen shows (kernel "失败与恢复"): `saved` nothing waits;
 * `syncing` a batch is on its way; `confirming` the outcome is being looked up;
 * `offline` it will be retried; `attention` the user needs to look (drafts or an error);
 * `reauth` sign in again; `upgrade` reload the page; `readonly` the browser lacks Web Locks.
 */
export type SaveStatus =
  'saved' | 'syncing' | 'confirming' | 'offline' | 'attention' | 'reauth' | 'upgrade' | 'readonly';

export type SenderOptions<Intent> = {
  journal: Journal<Intent>;
  userId: string;
  diaryId: string;
  transport: SyncTransport;
  onStatus: (status: SaveStatus) => void;
  /** Refused input moved to drafts; the editor must reload from the journal (D7). */
  onDrafts: (drafts: Draft<Intent>[]) => void;
};

export type Sender = {
  /** Something may be waiting: an operation was appended, or the connection came back. */
  wake(): void;
  stop(): void;
};

const RETRY_FIRST_MS = 1_000;
const RETRY_MAX_MS = 30_000;

export const sendLockName = (userId: string, diaryId: string) =>
  `between-pages-send:${userId}:${diaryId}`;

export function createSender<Intent>({
  journal,
  userId,
  diaryId,
  transport,
  onStatus,
  onDrafts,
}: SenderOptions<Intent>): Sender {
  const locks = globalThis.navigator?.locks;
  /** Set for good: nothing this instance does can make sending safe again. */
  let halted: 'readonly' | 'upgrade' | 'stopped' | null = locks ? null : 'readonly';
  let running = false;
  let again = false;
  let retryMs = RETRY_FIRST_MS;
  /** Set while the server asked for a pause; new input does not cut it short. */
  let timer: ReturnType<typeof setTimeout> | undefined;

  const status = (next: SaveStatus) => {
    if (halted !== 'stopped') onStatus(next);
  };
  if (halted) status(halted as SaveStatus);

  const retryLater = () => {
    status('offline');
    timer = setTimeout(() => {
      timer = undefined;
      wake();
    }, retryMs);
    retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
  };

  /** Returns whether to go on with the next batch. */
  async function settle(batch: SendBatch, result: SubmitResult): Promise<boolean> {
    if (result.type === 'ack') {
      await journal.confirm(diaryId, result.receipt);
      retryMs = RETRY_FIRST_MS;
      return true;
    }
    // No connection: the next wake, when it is back, resends the same batch.
    if (result.type === 'offline') {
      status('offline');
      return false;
    }
    switch (errorCategory[result.code]) {
      case 'retry':
        retryLater();
        return false;
      case 'reconcile': {
        // Committed but not acknowledged is saved, never a draft (invariant 21).
        status('confirming');
        const receipt = await transport.receipt(diaryId, batch.batchId);
        if (receipt) {
          await journal.confirm(diaryId, receipt);
          return true;
        }
        const reason = result.code === 'STALE_CONTEXT' ? 'stale-generation' : 'rejected';
        onDrafts(await journal.reject(diaryId, batch.batchId, reason));
        status('attention');
        return true;
      }
      case 'stop':
        onDrafts(await journal.reject(diaryId, batch.batchId, 'rejected'));
        status('attention');
        return true;
      case 'reauth':
        status('reauth');
        return false;
      case 'upgrade':
        halted = 'upgrade';
        status('upgrade');
        return false;
      case 'show':
        status('attention');
        return false;
    }
  }

  async function drain() {
    for (;;) {
      if (halted) return;
      const batch = await journal.nextBatch(diaryId);
      if (!batch) {
        if (!again) return status('saved');
        again = false;
        continue;
      }
      status('syncing');
      const result = await transport.submit(batch);
      if (halted) return;
      if (!(await settle(batch, result))) return;
    }
  }

  function wake() {
    if (halted || !locks || timer) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    again = false;
    // Something may wait from now on, so "saved" no longer holds until the queue says so.
    status('syncing');
    void locks
      .request(sendLockName(userId, diaryId), () =>
        drain().catch((error: unknown) => {
          if (error instanceof JournalUnavailable) {
            halted = 'upgrade';
            status('upgrade');
          } else retryLater();
        }),
      )
      .finally(() => {
        running = false;
        if (again) wake();
      });
  }

  return {
    wake,
    stop() {
      halted = 'stopped';
      clearTimeout(timer);
    },
  };
}
