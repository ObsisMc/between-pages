import { z } from 'zod';

// Personal diary wire shapes (kernel ADR D10). The internal commit version never appears
// here: clients address commits by (generationId, seq) and the random publicId (D2).

const Uuid = z.uuid();

// Intl also accepts UTC offsets such as "+08:00"; an offset is not a zone and drifts
// across daylight-saving changes, so only names are allowed.
function isTimeZone(value: string): boolean {
  if (!/^[A-Za-z]/.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    // RangeError is the only failure: the runtime does not know this zone name.
    return false;
  }
}

/** An IANA zone name such as `Asia/Shanghai`; decides which date "today" is (spec §4). */
export const TimeZone = z.string().max(64).refine(isTimeZone, 'must be an IANA time zone');

export const DiaryParams = z.object({ diaryId: Uuid });

export const OpenDiaryRequest = z
  .strictObject({
    timezone: TimeZone,
    /** A past date to open or back-fill; omitted means today in `timezone`. */
    date: z.iso.date().optional(),
  })
  .meta({ id: 'OpenDiaryRequest' });

/** Who owns a Yjs clientID in one diary; authors are derived from these (kernel D3). */
export const ClientBinding = z
  .object({ clientId: z.int().min(0).max(0xffffffff), userId: Uuid })
  .meta({ id: 'ClientBinding' });
export type ClientBinding = z.infer<typeof ClientBinding>;

export const DiaryState = z
  .object({
    diaryId: Uuid,
    diaryDate: z.iso.date(),
    ownerId: Uuid,
    generationId: Uuid,
    /** Commits since the generation's baseline (0 = baseline only). */
    seq: z.int().nonnegative(),
    /** The generation's committed Yjs state, base64. */
    state: z.base64(),
    bindings: z.array(ClientBinding),
  })
  .meta({ id: 'DiaryState' });

export const OpenDiaryResponse = z
  .object({ created: z.boolean(), diary: DiaryState })
  .meta({ id: 'OpenDiaryResponse' });

export const DiaryResponse = z.object({ diary: DiaryState }).meta({ id: 'DiaryResponse' });

/** The result of one committed send batch; the same for its ACK and every later query. */
export const CommitReceipt = z
  .object({
    batchId: Uuid,
    operationIds: z.array(Uuid),
    generationId: Uuid,
    seq: z.int().positive(),
    publicId: Uuid,
    committedAt: z.iso.datetime({ offset: true }),
  })
  .meta({ id: 'CommitReceipt' });
export type CommitReceipt = z.infer<typeof CommitReceipt>;

export const ReceiptQuery = z
  .strictObject({ batchId: Uuid.optional(), operationId: Uuid.optional() })
  .refine(
    (query) => (query.batchId === undefined) !== (query.operationId === undefined),
    'give exactly one of batchId and operationId',
  );

/** `receipt: null` means nothing with that ID is committed in this diary by the caller. */
export const ReceiptResponse = z
  .object({ receipt: CommitReceipt.nullable() })
  .meta({ id: 'ReceiptResponse' });

export const HistoryQuery = z.strictObject({ cursor: z.string().max(256).optional() });

/** One history list item (kernel D6), addressed by its representative commit. */
export const HistoryPoint = z
  .object({ publicId: Uuid, committedAt: z.iso.datetime({ offset: true }), authors: z.array(Uuid) })
  .meta({ id: 'HistoryPoint' });

/**
 * `nextPointInMs`: how long until the group being written becomes a point if nothing
 * joins it, so the client can fetch it then; null when no group is open. It is relative
 * because the device clock may differ from the server's.
 */
export const HistoryPage = z
  .object({
    points: z.array(HistoryPoint),
    nextCursor: z.string().nullable(),
    nextPointInMs: z.number().int().nonnegative().nullable(),
  })
  .meta({ id: 'HistoryPage' });

export const HistoryVersionParams = z.object({ diaryId: Uuid, publicId: Uuid });

/** A read-only historical text rendered by the server: author runs, no CRDT data (D6). */
export const HistoryVersion = z
  .object({
    publicId: Uuid,
    committedAt: z.iso.datetime({ offset: true }),
    runs: z.array(z.object({ author: Uuid, text: z.string() })),
  })
  .meta({ id: 'HistoryVersion' });
