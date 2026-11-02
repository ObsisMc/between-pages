import { z } from 'zod';
import { RecordUnread, Stamp } from './space-records.ts';
import { UserSummary } from './users.ts';

// Wishes and gifts wire shapes (wishes-and-gifts ADR). A gift being prepared, its card and
// the giver's "我在准备" appear only in the giver's own answers until it is revealed (D2);
// nothing in the receiver's answers tells whether anyone is preparing.

const Uuid = z.uuid();
const Timestamp = z.iso.datetime({ offset: true });
const Revision = z.number().int().positive();

export const WishName = z.string().trim().min(1).max(100);
/** Only http and https; shown as a preview the worker reads once (D7). */
export const WishLink = z
  .url({ protocol: /^https?$/ })
  .max(2000)
  .nullable();
const WishNote = z.string().trim().max(500).nullable();
/** How much it is wanted, shown as 1–5 hearts (D1). */
const Want = z.number().int().min(1).max(5).nullable();

/**
 * Actions of the feature (D6, space-records D4); the database accepts only these. `prepare`
 * and `unprepare` are the giver's private "我在准备" on a wish of the partner.
 */
export const WishActionKind = z.enum(['prepare', 'unprepare', 'receive']);
export const GiftActionKind = z.enum(['reveal', 'set_date', 'set_occasion']);

/** Generic occasions of a gift (D5); the other kind of occasion is one anniversary (anniversaries D4). */
export const GiftOccasion = z
  .enum(['holiday', 'meeting', 'no_reason'])
  .meta({ id: 'GiftOccasion' });
export type GiftOccasion = z.infer<typeof GiftOccasion>;

/**
 * What the worker read from a link (D7): `pending` until it has tried, then `ready` with
 * whatever it found, each field possibly null. Null when there is no link. The image is an
 * https address on the original site; the server never stores the image.
 */
export const LinkPreview = z
  .object({
    state: z.enum(['pending', 'ready']),
    title: z.string().nullable(),
    site: z.string().nullable(),
    image: z.string().nullable(),
  })
  .nullable()
  .meta({ id: 'LinkPreview' });

/** `mark` goes back in a seen report once the record was on screen (space-records D8). */
const Unseen = { unread: RecordUnread, mark: z.number().int().nonnegative() };

export const Wish = z
  .object({
    id: Uuid,
    authorId: Uuid,
    name: z.string(),
    link: z.string().nullable(),
    note: z.string().nullable(),
    want: z.number().int().nullable(),
    preview: LinkPreview,
    revision: Revision,
    createdAt: Timestamp,
    updatedAt: Timestamp,
    /** The caller's own gift in preparation for this wish of the partner; null otherwise. */
    preparingGiftId: Uuid.nullable(),
    ...Unseen,
  })
  .meta({ id: 'Wish' });

export const GiftCard = z
  .object({ id: Uuid, text: z.string(), revision: Revision, updatedAt: Timestamp, ...Unseen })
  .meta({ id: 'GiftCard' });

export const Gift = z
  .object({
    id: Uuid,
    authorId: Uuid,
    giverId: Uuid,
    receiverId: Uuid,
    /** The wish it was prepared for or received from; null for a surprise off the list. */
    wishId: Uuid.nullable(),
    name: z.string(),
    link: z.string().nullable(),
    preview: LinkPreview,
    status: z.enum(['preparing', 'revealed']),
    revealed: Stamp.nullable(),
    /** The gift wall's date; the revealer's local day unless someone changed it. */
    date: z.iso.date().nullable(),
    dateSet: Stamp.nullable(),
    occasion: GiftOccasion.nullable(),
    /**
     * The anniversary it was given for, with its name when that was set (anniversaries D4);
     * the name stays after the anniversary is deleted. Never set together with `occasion`.
     */
    anniversary: z.object({ id: Uuid, name: z.string() }).nullable(),
    occasionSet: Stamp.nullable(),
    card: GiftCard.nullable(),
    revision: Revision,
    createdAt: Timestamp,
    ...Unseen,
  })
  .meta({ id: 'Gift' });

/**
 * The partner deleted a record the caller had acted on (space-records D6): `prepared` when
 * the caller was preparing a gift for that wish, `acted` for any other action.
 */
export const DeletionNote = z
  .object({
    type: z.enum(['wish', 'gift']),
    id: Uuid,
    name: z.string(),
    deleted: Stamp,
    acted: z.enum(['prepared', 'acted']),
    ...Unseen,
  })
  .meta({ id: 'DeletionNote' });

/**
 * Everything of the feature the caller may see. `readOnly` once unbound (space-records D5).
 * `preparing` is only ever the caller's own; `wall` holds every revealed gift, newest first.
 */
export const WishesResponse = z
  .object({
    me: UserSummary,
    partner: UserSummary,
    readOnly: z.boolean(),
    mine: z.array(Wish),
    theirs: z.array(Wish),
    preparing: z.array(Gift),
    wall: z.array(Gift),
    notes: z.array(DeletionNote),
  })
  .meta({ id: 'WishesResponse' });

export const WishParams = z.object({ wishId: Uuid });
export const GiftParams = z.object({ giftId: Uuid });

const WishFields = { name: WishName, link: WishLink, note: WishNote, want: Want };

export const CreateWishRequest = z
  .strictObject({ requestId: Uuid, ...WishFields })
  .meta({ id: 'CreateWishRequest' });

export const EditWishRequest = z
  .strictObject({ expectedRevision: Revision, ...WishFields })
  .meta({ id: 'EditWishRequest' });

/** An action that only needs to be sent once (space-records D4). */
export const ActionRequest = z.strictObject({ requestId: Uuid }).meta({ id: 'ActionRequest' });

/**
 * "我在准备" on a wish of the partner (`wishId`), or a surprise off the list, which needs a
 * name (D2).
 */
export const PrepareGiftRequest = z
  .strictObject({
    requestId: Uuid,
    wishId: Uuid.nullable(),
    name: WishName.optional(),
    link: WishLink.optional(),
  })
  .refine(
    (r) =>
      r.wishId === null ? r.name !== undefined : r.name === undefined && r.link === undefined,
    'a surprise needs a name; a gift for a wish takes the wish’s',
  )
  .meta({ id: 'PrepareGiftRequest' });

export const EditGiftRequest = z
  .strictObject({ expectedRevision: Revision, name: WishName, link: WishLink })
  .meta({ id: 'EditGiftRequest' });

/** `expectedRevision` is null to write the first card (D3). */
export const SaveCardRequest = z
  .strictObject({
    expectedRevision: Revision.nullable(),
    text: z.string().trim().min(1).max(1000),
  })
  .meta({ id: 'SaveCardRequest' });

export const SetGiftDateRequest = z
  .strictObject({ requestId: Uuid, date: z.iso.date() })
  .meta({ id: 'SetGiftDateRequest' });

/** A generic occasion, an anniversary of the space, or neither to clear it (anniversaries D4). */
export const SetGiftOccasionRequest = z
  .strictObject({
    requestId: Uuid,
    occasion: GiftOccasion.nullable(),
    anniversaryId: Uuid.nullable(),
  })
  .refine((r) => r.occasion === null || r.anniversaryId === null, 'one occasion at most')
  .meta({ id: 'SetGiftOccasionRequest' });

export const WishResponse = z.object({ wish: Wish }).meta({ id: 'WishResponse' });
export const GiftResponse = z.object({ gift: Gift }).meta({ id: 'GiftResponse' });
export const DeletedResponse = z
  .object({ deleted: z.literal(true) })
  .meta({ id: 'DeletedResponse' });

/**
 * "收到了" names only the gift it put on the wall, a fresh ID either way, so the answer is
 * the same whether or not the partner was preparing one (invariant 2).
 */
export const ReceiveWishResponse = z.object({ giftId: Uuid }).meta({ id: 'ReceiveWishResponse' });
