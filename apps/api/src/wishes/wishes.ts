import { randomUUID } from 'node:crypto';
import type { BodyOf, ResponseOf } from '@between-pages/contracts';
import { isoDateIn } from '@between-pages/time';
import {
  Refused,
  authorOnly,
  derivedRequest,
  keyOf,
  requestDigest,
  type RecordRef,
  type Refusal,
  type SpaceRecords,
  type Unseen,
  type WriteContext,
} from '../space-records/space-records.ts';
import type { Tx } from '../store/store.ts';
import {
  WishQueries,
  WishWrites,
  type CardRow,
  type GiftRow,
  type WishRow,
} from '../store/wishes.ts';

// Wishes and gifts (wishes-and-gifts ADR), written only through space-records. A gift in
// preparation, its card and the giver's "我在准备" are private to the giver (D2, space-records
// D9): the receiver's answers are built from rows `visibleTo` them, and the wisher's actions
// on a wish under preparation answer exactly as they would without it (invariant 2).

type Wish = ResponseOf<'createWish'>['wish'];
type Gift = ResponseOf<'prepareGift'>['gift'];
type Present = {
  tx: Tx;
  caller: string;
  unseen: (refs: readonly RecordRef[]) => Promise<Map<string, Unseen>>;
};

const wishRef = (id: string): RecordRef => ({ type: 'wish', id });
const giftRef = (id: string): RecordRef => ({ type: 'gift', id });
const cardRef = (id: string): RecordRef => ({ type: 'gift_card', id });
const NOTHING_NEW: Unseen = { unread: null, mark: 0 };

const stamp = (by: string | null, at: Date | null) =>
  by && at ? { by, at: at.toISOString() } : null;

const preview = (row: {
  link: string | null;
  previewTitle: string | null;
  previewSite: string | null;
  previewImage: string | null;
  previewReadAt: Date | null;
}) =>
  row.link === null
    ? null
    : {
        state: row.previewReadAt ? ('ready' as const) : ('pending' as const),
        title: row.previewTitle,
        site: row.previewSite,
        image: row.previewImage,
      };
const unreadPreview = {
  previewTitle: null,
  previewSite: null,
  previewImage: null,
  previewReadAt: null,
};
const copiedPreview = (row: WishRow) => ({
  link: row.link,
  previewTitle: row.previewTitle,
  previewSite: row.previewSite,
  previewImage: row.previewImage,
  previewReadAt: row.previewReadAt,
});

function wishBody(row: WishRow, unseen: Unseen, preparingGiftId: string | null): Wish {
  return {
    id: row.id,
    authorId: row.authorId,
    name: row.name,
    link: row.link,
    note: row.note,
    want: row.want,
    preview: preview(row),
    revision: row.revision,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    preparingGiftId,
    ...unseen,
  };
}

function giftBody(row: GiftRow, card: CardRow | undefined, unseen: Map<string, Unseen>): Gift {
  return {
    id: row.id,
    authorId: row.authorId,
    giverId: row.giverId,
    receiverId: row.receiverId,
    wishId: row.wishId,
    name: row.name,
    link: row.link,
    preview: preview(row),
    status: row.status,
    revealed: stamp(row.revealedBy, row.revealedAt),
    date: row.giftDate,
    dateSet: stamp(row.dateSetBy, row.dateSetAt),
    occasion: row.occasion,
    anniversary: row.occasionAnniversaryId
      ? { id: row.occasionAnniversaryId, name: row.occasionName! }
      : null,
    occasionSet: stamp(row.occasionSetBy, row.occasionSetAt),
    card: card
      ? {
          id: card.id,
          text: card.body,
          revision: card.revision,
          updatedAt: card.updatedAt.toISOString(),
          ...(unseen.get(keyOf(cardRef(card.id))) ?? NOTHING_NEW),
        }
      : null,
    revision: row.revision,
    createdAt: row.createdAt.toISOString(),
    ...(unseen.get(keyOf(giftRef(row.id))) ?? NOTHING_NEW),
  };
}

async function giftsOut(ctx: Present, rows: GiftRow[]): Promise<Gift[]> {
  const cards = await new WishQueries(ctx.tx).cards(
    ctx.caller,
    rows.map((g) => g.id),
  );
  const cardOf = new Map(cards.map((c) => [c.giftId, c]));
  const unseen = await ctx.unseen([
    ...rows.map((g) => giftRef(g.id)),
    ...cards.map((c) => cardRef(c.id)),
  ]);
  return rows.map((g) => giftBody(g, cardOf.get(g.id), unseen));
}

async function wishOut(ctx: Present, row: WishRow): Promise<Wish> {
  const unseen = await ctx.unseen([wishRef(row.id)]);
  return wishBody(row, unseen.get(keyOf(wishRef(row.id)))!, null);
}

/**
 * A revealed gift's wall date (partner-local-dates D4): the receiver's local date, else the
 * revealer's, else UTC.
 */
const receiverDate = async (w: WishWrites, receiver: string, revealer: string, now: Date) =>
  isoDateIn(now.getTime(), (await w.timezoneOf(receiver)) ?? (await w.timezoneOf(revealer)));

const editedLink = (before: string | null, after: string | null) =>
  before === after ? {} : { link: after, ...unreadPreview };

export function createWishService(records: SpaceRecords) {
  const writes = (ctx: WriteContext) => new WishWrites(ctx.tx);

  /** Reveals a gift in preparation and its card in the caller's transaction (D4, space-records D9). */
  async function reveal(ctx: WriteContext, gift: GiftRow, now: Date) {
    const w = writes(ctx);
    const revealed = await w.updateGift(gift.id, {
      status: 'revealed',
      privateTo: null,
      revealedAt: now,
      revealedBy: ctx.caller,
      giftDate: await receiverDate(w, gift.receiverId, ctx.caller, now),
    });
    const card = await w.lockCard(gift.id);
    if (card) await w.updateCard(card.id, { privateTo: null });
    return revealed;
  }

  const action = (route: string, input: unknown, requestId: string) => ({
    id: requestId,
    digest: requestDigest(route, input),
    source: 'action' as const,
  });
  const change = (route: string, input: unknown, requestId: string) => ({
    id: requestId,
    digest: requestDigest(route, input),
    source: 'change' as const,
  });

  return {
    async view(caller: string): Promise<ResponseOf<'wishes'> | 'NOT_FOUND'> {
      return records.read(caller, async (ctx) => {
        const q = new WishQueries(ctx.tx);
        const [listed, preparing, wall, people] = await Promise.all([
          q.listedWishes(ctx.spaceId),
          q.preparing(caller, ctx.spaceId),
          q.wall(ctx.spaceId),
          q.people([caller, ctx.partnerId]),
        ]);
        const unseen = await ctx.unseen(listed.map((w) => wishRef(w.id)));
        const preparingFor = new Map(
          preparing.flatMap((g) => (g.wishId ? [[g.wishId, g.id] as const] : [])),
        );
        const wishOf = (w: WishRow) =>
          wishBody(w, unseen.get(keyOf(wishRef(w.id)))!, preparingFor.get(w.id) ?? null);
        const notes = await ctx.deletionNotes(['wish', 'gift']);
        const names = await q.names(
          caller,
          notes.filter((n) => n.ref.type === 'wish').map((n) => n.ref.id),
          notes.filter((n) => n.ref.type === 'gift').map((n) => n.ref.id),
        );
        const person = (id: string) => people.find((p) => p.id === id)!;
        return {
          me: person(caller),
          partner: person(ctx.partnerId),
          readOnly: ctx.readOnly,
          mine: listed.filter((w) => w.authorId === caller).map(wishOf),
          theirs: listed.filter((w) => w.authorId !== caller).map(wishOf),
          preparing: await giftsOut(ctx, preparing),
          wall: await giftsOut(ctx, wall),
          notes: notes
            .sort((a, b) => b.deletedAt.getTime() - a.deletedAt.getTime())
            .map((n) => ({
              type: n.ref.type as 'wish' | 'gift',
              id: n.ref.id,
              name: names.get(n.ref.id) ?? '',
              deleted: { by: n.deletedBy, at: n.deletedAt.toISOString() },
              acted: n.acted.has('prepare') ? ('prepared' as const) : ('acted' as const),
              unread: n.unread ? ('acted' as const) : null,
              mark: n.mark,
            })),
        };
      });
    },

    /** The wall's gifts given for one anniversary, for its page (anniversaries D5). */
    async giftsFor(
      caller: string,
      anniversaryId: string,
    ): Promise<{ id: string; name: string; giverId: string; date: string }[] | 'NOT_FOUND'> {
      return records.read(caller, async (ctx) =>
        (await new WishQueries(ctx.tx).forAnniversary(ctx.spaceId, anniversaryId)).map((g) => ({
          id: g.id,
          name: g.name,
          giverId: g.giverId,
          date: g.giftDate!,
        })),
      );
    },

    /** Records holding something the caller has not seen, for the entry dot (space-records D8). */
    async unread(caller: string): Promise<number | 'NOT_FOUND'> {
      const view = await this.view(caller);
      if (view === 'NOT_FOUND') return view;
      const gifts = [...view.preparing, ...view.wall];
      return [
        ...view.mine,
        ...view.theirs,
        ...gifts,
        ...gifts.flatMap((g) => (g.card ? [g.card] : [])),
        ...view.notes,
      ].filter((r) => r.unread !== null).length;
    },

    createWish(caller: string, body: BodyOf<'createWish'>): Promise<Wish | Refusal> {
      const request = change('createWish', body, body.requestId);
      return records.write(
        caller,
        request,
        async (ctx) => {
          const row = await writes(ctx).insertWish({
            id: randomUUID(),
            spaceId: ctx.spaceId,
            authorId: caller,
            createdPeriodId: ctx.periodId,
            name: body.name,
            link: body.link,
            note: body.note || null,
            want: body.want,
          });
          await ctx.changed(wishRef(row.id), 'create', null, request);
          return wishOut(ctx, row);
        },
        async (ctx, hit) => wishOut(ctx, (await writes(ctx).wish(ctx.spaceId, hit.recordId))!),
      );
    },

    editWish(caller: string, wishId: string, body: BodyOf<'editWish'>): Promise<Wish | Refusal> {
      return records.write(caller, null, async (ctx) => {
        const w = writes(ctx);
        const wish = await w.lockWish(ctx.spaceId, wishId);
        if (!wish || wish.receivedAt) throw new Refused('NOT_FOUND');
        authorOnly(caller, wish);
        if (wish.revision !== body.expectedRevision) throw new Refused('RECORD_STALE');
        const row = await w.updateWish(wish.id, {
          name: body.name,
          note: body.note || null,
          want: body.want,
          ...editedLink(wish.link, body.link),
          revision: wish.revision + 1,
          updatedAt: new Date(),
        });
        await ctx.changed(wishRef(wish.id), 'edit', null);
        return wishOut(ctx, row);
      });
    },

    /**
     * Deleting a wish someone is preparing for turns that gift into a surprise off the list,
     * card kept (D2); the answer is the same either way.
     */
    deleteWish(caller: string, wishId: string, requestId: string): Promise<true | Refusal> {
      const request = change('deleteWish', { wishId }, requestId);
      return records.write(
        caller,
        request,
        async (ctx) => {
          const w = writes(ctx);
          const wish = await w.lockWish(ctx.spaceId, wishId);
          if (!wish || wish.receivedAt) throw new Refused('NOT_FOUND');
          authorOnly(caller, wish);
          const preparing = await w.preparingFor(wish.id);
          if (preparing) await w.updateGift(preparing.id, { wishId: null });
          const now = new Date();
          await w.updateWish(wish.id, { deletedAt: now, deletedBy: caller });
          await ctx.changed(wishRef(wish.id), 'delete', null, request);
          return true as const;
        },
        async () => true as const,
      );
    },

    /**
     * "收到了" (D4): the partner's gift in preparation is revealed with its card, or, if none,
     * a gift from the partner goes on the wall. Either way the answer names a gift the
     * caller had never seen. On a wish already received it answers that wish's gift and
     * changes nothing: the giver's "揭晓" may have committed first (D4, 失败与恢复).
     */
    receiveWish(
      caller: string,
      wishId: string,
      requestId: string,
      now: Date,
    ): Promise<{ giftId: string } | Refusal> {
      const request = action('receiveWish', { wishId }, requestId);
      return records.write(
        caller,
        request,
        async (ctx) => {
          const w = writes(ctx);
          const wish = await w.lockWish(ctx.spaceId, wishId);
          if (!wish) throw new Refused('NOT_FOUND');
          authorOnly(caller, wish);
          if (wish.receivedAt) {
            const gift = await w.revealedFor(ctx.spaceId, wish.id);
            if (!gift || gift.deletedAt) throw new Refused('NOT_FOUND');
            return { giftId: gift.id };
          }
          await w.updateWish(wish.id, { receivedAt: now, receivedBy: caller });
          await ctx.acted(wishRef(wish.id), 'receive', null, request);
          const preparing = await w.preparingFor(wish.id);
          if (preparing) {
            await reveal(ctx, preparing, now);
            await ctx.acted(
              giftRef(preparing.id),
              'reveal',
              null,
              derivedRequest(request, 'reveal'),
            );
            return { giftId: preparing.id };
          }
          const gift = await w.insertGift({
            id: randomUUID(),
            spaceId: ctx.spaceId,
            authorId: caller,
            createdPeriodId: ctx.periodId,
            giverId: ctx.partnerId,
            receiverId: caller,
            wishId: wish.id,
            name: wish.name,
            ...copiedPreview(wish),
            status: 'revealed',
            revealedAt: now,
            revealedBy: caller,
            giftDate: await receiverDate(w, caller, caller, now),
          });
          await ctx.changed(giftRef(gift.id), 'create', null);
          return { giftId: gift.id };
        },
        async (ctx) => ({ giftId: (await writes(ctx).revealedFor(ctx.spaceId, wishId))!.id }),
      );
    },

    /**
     * "我在准备" on a wish of the partner, or a surprise (D2). A wish has at most one gift in
     * preparation and only one possible giver, so preparing it again returns that gift.
     */
    prepareGift(caller: string, body: BodyOf<'prepareGift'>): Promise<Gift | Refusal> {
      const request = change('prepareGift', body, body.requestId);
      return records.write(
        caller,
        request,
        async (ctx) => {
          const w = writes(ctx);
          const base = {
            id: randomUUID(),
            spaceId: ctx.spaceId,
            authorId: caller,
            createdPeriodId: ctx.periodId,
            privateTo: caller,
            giverId: caller,
            receiverId: ctx.partnerId,
            status: 'preparing' as const,
          };
          if (body.wishId === null) {
            const gift = await w.insertGift({
              ...base,
              wishId: null,
              name: body.name!,
              link: body.link ?? null,
            });
            await ctx.changed(giftRef(gift.id), 'create', caller, request);
            return (await giftsOut(ctx, [gift]))[0]!;
          }
          const wish = await w.lockWish(ctx.spaceId, body.wishId);
          if (!wish || wish.receivedAt || wish.authorId === caller) throw new Refused('NOT_FOUND');
          const existing = await w.preparingFor(wish.id);
          if (existing) return (await giftsOut(ctx, [existing]))[0]!;
          const gift = await w.insertGift({
            ...base,
            wishId: wish.id,
            name: wish.name,
            ...copiedPreview(wish),
          });
          await ctx.changed(giftRef(gift.id), 'create', caller, request);
          await ctx.acted(wishRef(wish.id), 'prepare', caller, derivedRequest(request, 'prepare'));
          return (await giftsOut(ctx, [gift]))[0]!;
        },
        async (ctx, hit) => {
          const gift = await writes(ctx).gift(caller, ctx.spaceId, hit.recordId);
          if (!gift) throw new Refused('NOT_FOUND');
          return (await giftsOut(ctx, [gift]))[0]!;
        },
      );
    },

    editGift(caller: string, giftId: string, body: BodyOf<'editGift'>): Promise<Gift | Refusal> {
      return records.write(caller, null, async (ctx) => {
        const w = writes(ctx);
        const gift = await w.lockGift(caller, ctx.spaceId, giftId);
        if (!gift) throw new Refused('NOT_FOUND');
        authorOnly(caller, gift);
        if (gift.revision !== body.expectedRevision) throw new Refused('RECORD_STALE');
        const row = await w.updateGift(gift.id, {
          name: body.name,
          ...editedLink(gift.link, body.link),
          revision: gift.revision + 1,
          updatedAt: new Date(),
        });
        await ctx.changed(giftRef(gift.id), 'edit', gift.privateTo);
        return (await giftsOut(ctx, [row]))[0]!;
      });
    },

    /** For a gift in preparation this is "取消准备", which the receiver never learns of (D2). */
    deleteGift(caller: string, giftId: string, requestId: string): Promise<true | Refusal> {
      const request = change('deleteGift', { giftId }, requestId);
      return records.write(
        caller,
        request,
        async (ctx) => {
          const w = writes(ctx);
          const gift = await w.lockGift(caller, ctx.spaceId, giftId);
          if (!gift) throw new Refused('NOT_FOUND');
          authorOnly(caller, gift);
          if (gift.status === 'preparing' && gift.wishId)
            await ctx.acted(
              wishRef(gift.wishId),
              'unprepare',
              caller,
              derivedRequest(request, 'unprepare'),
            );
          await w.updateGift(gift.id, { deletedAt: new Date(), deletedBy: caller });
          await ctx.changed(giftRef(gift.id), 'delete', gift.privateTo, request);
          return true as const;
        },
        async () => true as const,
      );
    },

    /** "揭晓" by the giver (D4); a gift already revealed answers as it is now. */
    revealGift(
      caller: string,
      giftId: string,
      requestId: string,
      now: Date,
    ): Promise<Gift | Refusal> {
      const request = action('revealGift', { giftId }, requestId);
      const answer = async (ctx: WriteContext) => {
        const gift = await writes(ctx).gift(caller, ctx.spaceId, giftId);
        if (!gift || gift.deletedAt) throw new Refused('NOT_FOUND');
        return (await giftsOut(ctx, [gift]))[0]!;
      };
      return records.write(
        caller,
        request,
        async (ctx) => {
          const w = writes(ctx);
          // The wish before the gift, the lock order every flow keeps.
          const before = await w.gift(caller, ctx.spaceId, giftId);
          const wish = before?.wishId ? await w.lockWish(ctx.spaceId, before.wishId) : null;
          const gift = await w.lockGift(caller, ctx.spaceId, giftId);
          if (!gift || gift.giverId !== caller) throw new Refused('NOT_FOUND');
          if (gift.status === 'revealed') return answer(ctx);
          if (wish && gift.wishId === wish.id && !wish.receivedAt)
            await w.updateWish(wish.id, { receivedAt: now, receivedBy: caller });
          await reveal(ctx, gift, now);
          await ctx.acted(giftRef(gift.id), 'reveal', null, request);
          return answer(ctx);
        },
        answer,
      );
    },

    /** The giver's card (D3): private with its gift until the reveal. */
    saveCard(
      caller: string,
      giftId: string,
      body: BodyOf<'saveGiftCard'>,
    ): Promise<Gift | Refusal> {
      return records.write(caller, null, async (ctx) => {
        const w = writes(ctx);
        const gift = await w.lockGift(caller, ctx.spaceId, giftId);
        if (!gift || gift.giverId !== caller) throw new Refused('NOT_FOUND');
        const card = await w.lockCard(gift.id);
        if (body.expectedRevision === null) {
          if (card) throw new Refused('RECORD_STALE');
          const created = await w.insertCard({
            id: randomUUID(),
            spaceId: ctx.spaceId,
            authorId: caller,
            createdPeriodId: ctx.periodId,
            privateTo: gift.privateTo,
            giftId: gift.id,
            body: body.text,
          });
          await ctx.changed(cardRef(created.id), 'create', gift.privateTo);
        } else {
          if (!card || card.revision !== body.expectedRevision) throw new Refused('RECORD_STALE');
          await w.updateCard(card.id, {
            body: body.text,
            revision: card.revision + 1,
            updatedAt: new Date(),
          });
          await ctx.changed(cardRef(card.id), 'edit', card.privateTo);
        }
        return (await giftsOut(ctx, [gift]))[0]!;
      });
    },

    /**
     * Either of the two changes a revealed gift's date or occasion; each is an action (D5).
     * An anniversary as the occasion comes checked and named by the caller (anniversaries D4).
     */
    setGift(
      caller: string,
      giftId: string,
      set:
        | { kind: 'set_date'; date: string }
        | {
            kind: 'set_occasion';
            occasion: Gift['occasion'];
            anniversary: { id: string; name: string } | null;
          },
      requestId: string,
      now: Date,
    ): Promise<Gift | Refusal> {
      // The digest covers what was asked, not the name the anniversary has at the moment.
      const asked =
        set.kind === 'set_date'
          ? set
          : { kind: set.kind, occasion: set.occasion, anniversaryId: set.anniversary?.id ?? null };
      const request = action(set.kind, { giftId, set: asked }, requestId);
      const answer = async (ctx: WriteContext) => {
        const gift = await writes(ctx).gift(caller, ctx.spaceId, giftId);
        if (!gift) throw new Refused('NOT_FOUND');
        return (await giftsOut(ctx, [gift]))[0]!;
      };
      return records.write(
        caller,
        request,
        async (ctx) => {
          const w = writes(ctx);
          const gift = await w.lockGift(caller, ctx.spaceId, giftId);
          if (!gift || gift.status !== 'revealed') throw new Refused('NOT_FOUND');
          await w.updateGift(
            gift.id,
            set.kind === 'set_date'
              ? { giftDate: set.date, dateSetBy: caller, dateSetAt: now }
              : {
                  occasion: set.occasion,
                  occasionAnniversaryId: set.anniversary?.id ?? null,
                  occasionName: set.anniversary?.name ?? null,
                  occasionSetBy: caller,
                  occasionSetAt: now,
                },
          );
          await ctx.acted(giftRef(gift.id), set.kind, null, request);
          return answer(ctx);
        },
        answer,
      );
    },
  };
}

export type WishService = ReturnType<typeof createWishService>;
