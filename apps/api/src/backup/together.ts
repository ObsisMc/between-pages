import type { ResponseOf } from '@between-pages/contracts';
import type { AnniversaryService } from '../anniversaries/anniversaries.ts';
import { historyPoints, IDLE_MS, nextPointIn } from '../history/history.ts';
import type { SharedPageService } from '../shared-pages/shared-pages.ts';
import { pageIdOf, type Item, type TogetherStore } from '../store/together.ts';
import type { WishService } from '../wishes/wishes.ts';
import {
  renderAnniversaries,
  renderGifts,
  renderPage,
  renderWishes,
  type GiftEntry,
  type TogetherDoc,
  type WishEntry,
} from './render-together.ts';

// What one `Together` Doc in one person's Drive holds (google-copy-beyond-diaries D2–D7).
// Everything is read through the services' own per-viewer reads, the ones the routes use,
// so a Doc never holds what the person cannot read in the app (invariant 1): the summaries
// through `wishes` and `anniversaries` (private rows filtered, a gift in preparation only for
// its giver, invariant 2), a page through `shared-pages`, whose copy entry alone also reads a
// deleted page's last commit, for the two people of its space (D7). A page is written at
// its newest history point as a day is; a summary at its state now.

export type TogetherSources = {
  pages: SharedPageService;
  wishes: WishService;
  anniversaries: AnniversaryService;
};

export type ItemContent = {
  /** Null when there is nothing to write yet, or the item is not this person's. */
  written: { doc: TogetherDoc; coveredAt: Date } | null;
  /** A page's history point still forming: look at it again then. */
  recheckAt: Date | null;
  /** The page was deleted in the app: this is its last content (D7). */
  deleted: boolean;
};

const NOTHING: ItemContent = { written: null, recheckAt: null, deleted: false };

const OCCASIONS = { holiday: '节日', meeting: '见面', no_reason: '没什么理由' } as const;

type Wishes = ResponseOf<'wishes'>;
type Anniversaries = ResponseOf<'anniversaries'>;
type Person = { id: string; name: string };

const people = (view: { me: Wishes['me']; partner: Wishes['partner'] }) => ({
  viewer: { id: view.me.id, name: view.me.displayName },
  partner: { id: view.partner.id, name: view.partner.displayName },
});

const preview = (p: Wishes['mine'][number]['preview']) =>
  p && p.state === 'ready' ? { title: p.title, site: p.site } : null;

function anniversaryName(
  a: Pick<Anniversaries['anniversaries'][number], 'kind' | 'birthdayOf' | 'name'>,
  pair: Person[],
) {
  if (a.kind === 'together') return '在一起的日子';
  if (a.kind === 'birthday') return `${pair.find((p) => p.id === a.birthdayOf)?.name ?? ''} 的生日`;
  return a.name ?? '';
}

export function createTogetherCopy(
  store: TogetherStore,
  sources: TogetherSources,
  idleMs = IDLE_MS,
) {
  async function page(userId: string, pageId: string, now: Date, force: boolean) {
    const source = await sources.pages.copySource(userId, pageId);
    if (!source) return NOTHING;
    const { timeline } = source;
    let shown = timeline.at(-1) ?? null;
    let recheckAt: Date | null = null;
    if (!source.deleted && !force) {
      const point = historyPoints(timeline, now, idleMs).at(-1);
      shown = point ? timeline.find((c) => c.publicId === point.publicId)! : null;
      const forming = nextPointIn(timeline, now, idleMs);
      if (forming !== null) recheckAt = new Date(now.getTime() + forming);
      // Text is written only once it is in a history point (invariant 4).
      if (timeline.length && !shown) return { ...NOTHING, recheckAt };
    }
    const runs = shown ? await sources.pages.copyRuns(userId, pageId, shown) : [];
    const pair = await sources.pages.view(userId);
    if (pair === 'NOT_FOUND' || !runs) return NOTHING;
    const doc = renderPage({
      ...people(pair),
      unbound: source.readOnly,
      title: source.title,
      runs,
    });
    const times = [shown?.committedAt, source.titleAt ?? source.createdAt]
      .filter((t): t is Date => t instanceof Date)
      .map((t) => t.getTime());
    return {
      written: { doc, coveredAt: new Date(Math.max(...times)) },
      recheckAt,
      deleted: source.deleted,
    };
  }

  const wish =
    (preparing: ReadonlySet<string>) =>
    (w: Wishes['mine'][number]): WishEntry => ({
      authorId: w.authorId,
      name: w.name,
      want: w.want,
      link: w.link,
      preview: preview(w.preview),
      note: w.note,
      preparing: preparing.has(w.id),
    });

  async function summary(userId: string, item: Item, now: Date): Promise<ItemContent> {
    // The zone only moves "next" dates the Docs do not show; any zone gives the same Doc.
    if (item === 'anniversaries') {
      const view = await sources.anniversaries.view(userId, 'UTC', now);
      if (view === 'NOT_FOUND') return NOTHING;
      const doc = renderAnniversaries({
        ...people(view),
        unbound: view.readOnly,
        anniversaries: view.anniversaries,
      });
      return { written: { doc, coveredAt: now }, recheckAt: null, deleted: false };
    }
    const view = await sources.wishes.view(userId);
    if (view === 'NOT_FOUND') return NOTHING;
    const pair = people(view);
    if (item === 'wishes') {
      const preparing = new Set(view.theirs.filter((w) => w.preparingGiftId).map((w) => w.id));
      const doc = renderWishes({
        ...pair,
        unbound: view.readOnly,
        mine: view.mine.map(wish(new Set())),
        theirs: view.theirs.map(wish(preparing)),
      });
      return { written: { doc, coveredAt: now }, recheckAt: null, deleted: false };
    }
    const dates = await sources.anniversaries.view(userId, 'UTC', now);
    const alive = new Map(
      dates === 'NOT_FOUND' ? [] : dates.anniversaries.map((a) => [a.id, a] as const),
    );
    const named = [pair.viewer, pair.partner];
    const gift = (g: Wishes['wall'][number]): GiftEntry => {
      const anniversary = g.anniversary && alive.get(g.anniversary.id);
      return {
        giverId: g.giverId,
        receiverId: g.receiverId,
        name: g.name,
        link: g.link,
        preview: preview(g.preview),
        date: g.date,
        // An anniversary's current name; the copy the gift kept once it is deleted (D4).
        occasion: anniversary
          ? anniversaryName(anniversary, named)
          : (g.anniversary?.name ?? (g.occasion ? OCCASIONS[g.occasion] : null)),
        card: g.card?.text || null,
      };
    };
    const doc = renderGifts({
      ...pair,
      unbound: view.readOnly,
      preparing: view.preparing.map(gift),
      wall: view.wall.map(gift),
    });
    return { written: { doc, coveredAt: now }, recheckAt: null, deleted: false };
  }

  return {
    intake: (now: Date, onlyFor?: readonly string[]) => store.intake(now, onlyFor),

    /** The item's Doc for `userId` at `now`; `force` is "现在备份". */
    content(userId: string, item: Item, now: Date, force: boolean): Promise<ItemContent> {
      const pageId = pageIdOf(item);
      return pageId ? page(userId, pageId, now, force) : summary(userId, item, now);
    },
  };
}

export type TogetherCopy = ReturnType<typeof createTogetherCopy>;
