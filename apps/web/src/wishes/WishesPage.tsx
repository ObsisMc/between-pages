import { createContext, useContext, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { ChevronDown, Gift as GiftIcon, Lock, Plus } from 'lucide-react';
import type { GiftOccasion } from '@between-pages/contracts';
import { callApi } from '../api/client.ts';
import { Page, PageHeader } from '../shell/index.ts';
import {
  COPY_STAYS_NOTE,
  ReadOnlyNotice,
  StampText,
  UnreadJump,
  UnreadLabel,
  dayText,
  useRequestId,
  useSeen,
  useSeenReporter,
  type SeenTarget,
} from '../space-common/index.ts';
import {
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
  Input,
  Label,
  NativeSelect,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  ToggleGroup,
  ToggleGroupItem,
  cn,
} from '../ui/index.ts';
import {
  useOccasions,
  useWishes,
  useWrite,
  wishesKey,
  type Gift,
  type Occasion,
  type Wish,
  type WishesView,
} from './queries.ts';

// The wishes page (wishes-and-gifts ADR): both wish lists with links and hearts (D1), the
// caller's own gifts in preparation with their cards (D2, D3), revealing (D4), the gift wall
// with its date and occasion (D5), and notes of records the partner deleted (space-records
// D6). A gift in preparation exists only in the giver's answers, so nothing here hides it.
// The four lists are tabs (digital-paper-interface D3); every panel stays mounted, hidden
// while another shows, so a half-written card survives a switch, and a hidden record is not
// on screen, so it is never reported as seen.

const OCCASIONS: Record<GiftOccasion, string> = {
  holiday: '节日',
  meeting: '见面',
  no_reason: '没什么理由',
};

type Tab = 'theirs' | 'mine' | 'preparing' | 'wall';

const elementId = (type: string, id: string) => `${type}-${id}`;

/** Shows a record's tab and scrolls it into view, for links inside the page. */
const ShowRecord = createContext<(id: string) => void>(() => {});

// A gift's occasion as one select value: a generic occasion, or `a:` and an anniversary ID.
const ANNIVERSARY = 'a:';
const occasionValue = (gift: Gift) =>
  gift.anniversary ? ANNIVERSARY + gift.anniversary.id : (gift.occasion ?? '');
/**
 * An anniversary still in the space shows its name now; a deleted one, the name the gift
 * kept (anniversaries D4).
 */
const occasionText = (gift: Gift, occasions: Occasion[]) =>
  gift.anniversary
    ? (occasions.find((o) => o.id === gift.anniversary!.id)?.label ?? gift.anniversary.name)
    : gift.occasion && OCCASIONS[gift.occasion];

const alertClass = 'rounded-xl bg-notice px-4 py-3 text-sm text-ink';

function Refusal({ text }: { text: string | null }) {
  return text ? (
    <p className={cn(alertClass, 'mt-3')} role="alert">
      {text}
    </p>
  ) : null;
}

function Hearts({
  value,
  onChange,
}: {
  value: number | null;
  onChange?: (want: number | null) => void;
}) {
  if (!onChange)
    return value ? (
      <span className="tracking-widest text-warm" role="img" aria-label={`想要程度 ${value}/5`}>
        {'♥'.repeat(value)}
      </span>
    ) : null;
  return (
    <span className="flex gap-1" role="group" aria-label="想要程度">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          className={cn(
            'min-h-0 cursor-pointer rounded-md border-0 bg-transparent p-1 text-xl leading-none',
            value !== null && n <= value ? 'text-warm' : 'text-line',
          )}
          aria-pressed={value === n}
          aria-label={`${n} 颗心`}
          onClick={() => onChange(value === n ? null : n)}
        >
          ♥
        </button>
      ))}
    </span>
  );
}

const hostOf = (link: string) => {
  try {
    return new URL(link).hostname;
  } catch {
    return link;
  }
};

/** The worker's preview, the image loaded from the shop without a referrer (D7, invariant 8). */
function LinkPreview({ link, preview }: { link: string | null; preview: Wish['preview'] }) {
  const [broken, setBroken] = useState(false);
  if (!link) return null;
  const title = preview?.title ?? preview?.site ?? hostOf(link);
  return (
    <a
      className="mt-3 flex max-w-md items-center gap-3 rounded-xl border border-line p-2 text-ink no-underline hover:bg-accent"
      href={link}
      target="_blank"
      rel="noopener noreferrer"
    >
      {preview?.image && !broken && (
        <img
          className="size-14 shrink-0 rounded-lg object-cover"
          src={preview.image}
          alt=""
          referrerPolicy="no-referrer"
          onError={() => setBroken(true)}
        />
      )}
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-sm">{title}</span>
        <span className="text-xs text-ink-soft">{preview?.site ?? hostOf(link)}</span>
      </span>
    </a>
  );
}

type Fields = { name: string; link: string; note: string; want: number | null };
const blank: Fields = { name: '', link: '', note: '', want: null };

/** The fields of a wish, or of a surprise without note and hearts; the caller holds them. */
function WishForm({
  fields,
  onFields,
  submitText,
  withNote = true,
  busy,
  onSubmit,
  cancel,
}: {
  fields: Fields;
  onFields: (fields: Fields) => void;
  submitText: string;
  withNote?: boolean;
  busy: boolean;
  onSubmit: () => void;
  cancel: ReactNode;
}) {
  const set = (patch: Partial<Fields>) => onFields({ ...fields, ...patch });
  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <Label>
        名称
        <Input
          value={fields.name}
          maxLength={100}
          required
          onChange={(e) => set({ name: e.target.value })}
        />
      </Label>
      <Label>
        链接
        <Input
          type="url"
          value={fields.link}
          placeholder="https://"
          onChange={(e) => set({ link: e.target.value })}
        />
      </Label>
      {withNote && (
        <>
          <Label>
            备注
            <Input
              value={fields.note}
              maxLength={500}
              placeholder="尺码、颜色、哪个牌子都行"
              onChange={(e) => set({ note: e.target.value })}
            />
          </Label>
          <Hearts value={fields.want} onChange={(want) => set({ want })} />
        </>
      )}
      <div className="flex justify-end gap-2">
        {cancel}
        <Button type="submit" disabled={busy || !fields.name.trim()}>
          {submitText}
        </Button>
      </div>
    </form>
  );
}

const wishBody = (f: Fields) => ({
  name: f.name.trim(),
  link: f.link.trim() || null,
  note: f.note.trim() || null,
  want: f.want,
});

/** One record's element: an anchor for the unread jump, reported as seen once on screen. */
function Record({
  type,
  record,
  report,
  className,
  children,
}: {
  type: SeenTarget['type'];
  record: { id: string; unread: Wish['unread']; mark: number };
  report: (target: SeenTarget) => void;
  className: string;
  children: ReactNode;
}) {
  const ref = useSeen(record.unread ? { type, id: record.id, mark: record.mark } : null, report);
  return (
    <li
      id={elementId(type, record.id)}
      ref={ref}
      className={cn('flex gap-4 border-b border-line py-6', className)}
    >
      <span
        aria-hidden="true"
        className="hidden size-12 shrink-0 items-center justify-center rounded-xl bg-accent text-warm sm:flex [&_svg]:size-5"
      >
        <GiftIcon />
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </li>
  );
}

/** Small buttons on a record. */
function Actions({ children }: { children: ReactNode }) {
  return <div className="mt-3 flex flex-wrap items-center gap-2">{children}</div>;
}

function MyWish({
  wish,
  view,
  report,
}: {
  wish: Wish;
  view: WishesView;
  report: (t: SeenTarget) => void;
}) {
  const [editing, setEditing] = useState<Fields | null>(null);
  const write = useWrite();
  const [deleteId, renewDelete] = useRequestId();
  const [receiveId, renewReceive] = useRequestId();
  return (
    <Record type="wish" record={wish} report={report} className="wish">
      {editing ? (
        <WishForm
          fields={editing}
          onFields={setEditing}
          submitText="保存"
          busy={write.busy}
          cancel={
            <Button type="button" variant="ghost" onClick={() => setEditing(null)}>
              取消
            </Button>
          }
          onSubmit={() =>
            void write
              .run(() =>
                callApi('editWish', {
                  params: { wishId: wish.id },
                  body: { expectedRevision: wish.revision, ...wishBody(editing) },
                }),
              )
              .then((ok) => ok && setEditing(null))
          }
        />
      ) : (
        <>
          <WishFace wish={wish} />
          {!view.readOnly && (
            <Actions>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  setEditing({
                    name: wish.name,
                    link: wish.link ?? '',
                    note: wish.note ?? '',
                    want: wish.want,
                  })
                }
              >
                编辑
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={write.busy}
                onClick={() =>
                  void write
                    .run(() =>
                      callApi('receiveWish', {
                        params: { wishId: wish.id },
                        body: { requestId: receiveId },
                      }),
                    )
                    .then((ok) => ok && renewReceive())
                }
              >
                收到了
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={write.busy}
                onClick={() =>
                  window.confirm(`删除"${wish.name}"？${COPY_STAYS_NOTE}`) &&
                  void write
                    .run(() =>
                      callApi('deleteWish', {
                        params: { wishId: wish.id },
                        body: { requestId: deleteId },
                      }),
                    )
                    .then((ok) => ok && renewDelete())
                }
              >
                删除
              </Button>
            </Actions>
          )}
        </>
      )}
      <Refusal text={write.error} />
    </Record>
  );
}

function WishFace({ wish }: { wish: Wish }) {
  return (
    <>
      <p className="font-serif text-xl">
        {wish.name} <UnreadLabel unread={wish.unread} />
      </p>
      {wish.note && <p className="mt-1 text-sm text-ink-soft">{wish.note}</p>}
      {wish.want !== null && (
        <p className="mt-1 text-sm">
          <Hearts value={wish.want} />
        </p>
      )}
      <LinkPreview link={wish.link} preview={wish.preview} />
    </>
  );
}

function TheirWish({
  wish,
  view,
  report,
}: {
  wish: Wish;
  view: WishesView;
  report: (t: SeenTarget) => void;
}) {
  const write = useWrite();
  const [requestId, renew] = useRequestId();
  const show = useContext(ShowRecord);
  return (
    <Record type="wish" record={wish} report={report} className="wish">
      <WishFace wish={wish} />
      {wish.preparingGiftId ? (
        <p className="mt-3 text-sm text-ink-soft">
          你在准备 ·{' '}
          <Button
            type="button"
            variant="link"
            className="text-warm underline"
            onClick={() => show(elementId('gift', wish.preparingGiftId!))}
          >
            写卡片、揭晓
          </Button>
        </p>
      ) : (
        !view.readOnly && (
          <Actions>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={write.busy}
              onClick={() =>
                void write
                  .run(() => callApi('prepareGift', { body: { requestId, wishId: wish.id } }))
                  .then((ok) => ok && renew())
              }
            >
              我在准备
            </Button>
          </Actions>
        )
      )}
      <Refusal text={write.error} />
    </Record>
  );
}

const cardClass =
  'mt-3 border-l-2 border-warm pl-4 font-serif leading-relaxed whitespace-pre-wrap text-ink';

function CardEditor({
  gift,
  readOnly,
  showCard = true,
}: {
  gift: Gift;
  readOnly: boolean;
  showCard?: boolean;
}) {
  const [text, setText] = useState(gift.card?.text ?? '');
  const [open, setOpen] = useState(false);
  const write = useWrite();
  if (readOnly || !open)
    return (
      <>
        {showCard && gift.card && <blockquote className={cardClass}>{gift.card.text}</blockquote>}
        {!readOnly && (
          <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
            {gift.card ? '改卡片' : '写卡片'}
          </Button>
        )}
      </>
    );
  return (
    <form
      className="mt-3 grid w-full gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void write
          .run(() =>
            callApi('saveGiftCard', {
              params: { giftId: gift.id },
              body: { expectedRevision: gift.card?.revision ?? null, text: text.trim() },
            }),
          )
          .then((ok) => ok && setOpen(false));
      }}
    >
      <Label>
        卡片
        <Textarea value={text} maxLength={1000} onChange={(e) => setText(e.target.value)} />
      </Label>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={!text.trim() || write.busy}>
          保存卡片
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
          取消
        </Button>
      </div>
      <Refusal text={write.error} />
    </form>
  );
}

function Preparing({
  gift,
  view,
  report,
}: {
  gift: Gift;
  view: WishesView;
  report: (t: SeenTarget) => void;
}) {
  const write = useWrite();
  const [revealId, renewReveal] = useRequestId();
  const [deleteId, renewDelete] = useRequestId();
  const forWish = gift.wishId !== null;
  return (
    <Record type="gift" record={gift} report={report} className="gift preparing">
      <p className="font-serif text-xl">
        {gift.name}{' '}
        <span className="font-sans text-sm text-ink-soft">
          {forWish ? '心愿单上的' : '单外的惊喜'}
        </span>
      </p>
      <LinkPreview link={gift.link} preview={gift.preview} />
      <Actions>
        <CardEditor gift={gift} readOnly={view.readOnly} />
      </Actions>
      {!view.readOnly && (
        <Actions>
          <Button
            type="button"
            size="sm"
            disabled={write.busy}
            onClick={() =>
              window.confirm(`揭晓"${gift.name}"？揭晓后 TA 就能看到礼物和卡片，不能撤回。`) &&
              void write
                .run(() =>
                  callApi('revealGift', {
                    params: { giftId: gift.id },
                    body: { requestId: revealId },
                  }),
                )
                .then((ok) => ok && renewReveal())
            }
          >
            揭晓
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={write.busy}
            onClick={() =>
              window.confirm('取消准备？TA 不会知道。') &&
              void write
                .run(() =>
                  callApi('deleteGift', {
                    params: { giftId: gift.id },
                    body: { requestId: deleteId },
                  }),
                )
                .then((ok) => ok && renewDelete())
            }
          >
            取消准备
          </Button>
        </Actions>
      )}
      <Refusal text={write.error} />
    </Record>
  );
}

/** A card is a record of its own (D3), seen on its own. */
function WallCard({
  card,
  report,
}: {
  card: NonNullable<Gift['card']>;
  report: (t: SeenTarget) => void;
}) {
  const ref = useSeen(
    card.unread ? { type: 'gift_card', id: card.id, mark: card.mark } : null,
    report,
  );
  return (
    <blockquote ref={ref} className={cardClass}>
      {card.text} <UnreadLabel unread={card.unread} />
    </blockquote>
  );
}

function WallGift({
  gift,
  view,
  report,
}: {
  gift: Gift;
  view: WishesView;
  report: (t: SeenTarget) => void;
}) {
  const write = useWrite();
  const [dateId, renewDate] = useRequestId();
  const [occasionId, renewOccasion] = useRequestId();
  const [deleteId, renewDelete] = useRequestId();
  const occasions = useOccasions().data ?? [];
  const nameOf = (id: string) => (id === view.me.id ? '我' : view.partner.displayName);
  const fromMe = gift.giverId === view.me.id;
  const fresh = gift.unread === 'acted';
  const occasion = occasionText(gift, occasions);
  const linked = gift.anniversary && occasions.some((o) => o.id === gift.anniversary!.id);
  return (
    <Record type="gift" record={gift} report={report} className="gift">
      <p className="font-serif text-xl">
        {gift.name} <UnreadLabel unread={gift.unread} />
      </p>
      <p className="gift-meta mt-1 text-sm text-ink-soft">
        {fromMe ? `我送给 ${view.partner.displayName}` : `${view.partner.displayName} 送给我`}
        {gift.date && ` · ${gift.date}`}
        {occasion && ' · '}
        {linked ? (
          <Link
            to={`/anniversaries/${gift.anniversary!.id}`}
            className="text-warm underline underline-offset-4"
          >
            {occasion}
          </Link>
        ) : (
          occasion
        )}
      </p>
      <LinkPreview link={gift.link} preview={gift.preview} />
      {gift.card && <WallCard card={gift.card} report={report} />}
      {(gift.revealed || gift.dateSet || gift.occasionSet) && (
        <p className="mt-2">
          {gift.revealed && (
            <StampText
              name={nameOf(gift.revealed.by)}
              verb="揭晓了"
              at={gift.revealed.at}
              fresh={fresh}
            />
          )}
          {gift.dateSet && (
            <StampText
              name={nameOf(gift.dateSet.by)}
              verb="改了日期"
              at={gift.dateSet.at}
              fresh={fresh}
            />
          )}
          {gift.occasionSet && (
            <StampText
              name={nameOf(gift.occasionSet.by)}
              verb="改了场合"
              at={gift.occasionSet.at}
              fresh={fresh}
            />
          )}
        </p>
      )}
      {!view.readOnly && (
        <Collapsible className="mt-3">
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="group text-ink-soft">
              修改
              <ChevronDown
                aria-hidden="true"
                className="transition-transform group-data-[state=open]:rotate-180"
              />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-3 grid gap-4 rounded-xl border border-line p-4">
            <div className="flex flex-wrap items-end gap-4">
              <Label>
                日期
                <Input
                  type="date"
                  value={gift.date ?? ''}
                  onChange={(e) =>
                    e.target.value &&
                    void write
                      .run(() =>
                        callApi('setGiftDate', {
                          params: { giftId: gift.id },
                          body: { requestId: dateId, date: e.target.value },
                        }),
                      )
                      .then((ok) => ok && renewDate())
                  }
                />
              </Label>
              <Label>
                场合
                <NativeSelect
                  value={occasionValue(gift)}
                  onChange={(e) => {
                    const value = e.target.value;
                    const anniversary = value.startsWith(ANNIVERSARY);
                    void write
                      .run(() =>
                        callApi('setGiftOccasion', {
                          params: { giftId: gift.id },
                          body: {
                            requestId: occasionId,
                            occasion: anniversary ? null : ((value || null) as GiftOccasion | null),
                            anniversaryId: anniversary ? value.slice(ANNIVERSARY.length) : null,
                          },
                        }),
                      )
                      .then((ok) => ok && renewOccasion());
                  }}
                >
                  <option value="">未选</option>
                  <OccasionOptions gifts={[gift]} occasions={occasions} />
                </NativeSelect>
              </Label>
            </div>
            {(fromMe || gift.authorId === view.me.id) && (
              <div className="flex flex-wrap gap-2">
                {fromMe && <CardEditor gift={gift} readOnly={false} showCard={false} />}
                {gift.authorId === view.me.id && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={write.busy}
                    onClick={() =>
                      window.confirm(`从礼物墙删除"${gift.name}"？${COPY_STAYS_NOTE}`) &&
                      void write
                        .run(() =>
                          callApi('deleteGift', {
                            params: { giftId: gift.id },
                            body: { requestId: deleteId },
                          }),
                        )
                        .then((ok) => ok && renewDelete())
                    }
                  >
                    删除
                  </Button>
                )}
              </div>
            )}
          </CollapsibleContent>
        </Collapsible>
      )}
      <Refusal text={write.error} />
    </Record>
  );
}

/**
 * A form in a dialog that closes once sent; what was typed stays when it is closed unsent,
 * and a refusal keeps it open with the reason.
 */
function FormDialog({
  trigger,
  title,
  description,
  submitText,
  withNote,
  send,
}: {
  trigger: ReactNode;
  title: string;
  description?: string;
  submitText: string;
  withNote: boolean;
  send: (fields: Fields, requestId: string) => Promise<unknown>;
}) {
  const write = useWrite();
  const [requestId, renew] = useRequestId();
  const [open, setOpen] = useState(false);
  const [fields, setFields] = useState(blank);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent {...(description ? {} : { 'aria-describedby': undefined })}>
        <DialogTitle>{title}</DialogTitle>
        {description && <DialogDescription>{description}</DialogDescription>}
        <WishForm
          fields={fields}
          onFields={setFields}
          submitText={submitText}
          withNote={withNote}
          busy={write.busy}
          cancel={
            <DialogClose asChild>
              <Button type="button" variant="ghost">
                取消
              </Button>
            </DialogClose>
          }
          onSubmit={() =>
            void write
              .run(() => send(fields, requestId))
              .then((ok) => ok && (renew(), setFields(blank), setOpen(false)))
          }
        />
        {write.error && (
          <p className={alertClass} role="alert">
            {write.error}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Generic occasions, the space's anniversaries, and deleted ones these gifts still name, by
 * the name they kept.
 */
function OccasionOptions({ gifts, occasions }: { gifts: Gift[]; occasions: Occasion[] }) {
  const kept = new Map<string, string>();
  for (const g of gifts)
    if (g.anniversary && !occasions.some((o) => o.id === g.anniversary!.id))
      kept.set(g.anniversary.id, g.anniversary.name);
  return (
    <>
      {Object.entries(OCCASIONS).map(([value, text]) => (
        <option key={value} value={value}>
          {text}
        </option>
      ))}
      {[...occasions, ...[...kept].map(([id, label]) => ({ id, label }))].map((o) => (
        <option key={o.id} value={ANNIVERSARY + o.id}>
          {o.label}
        </option>
      ))}
    </>
  );
}

type Giver = 'all' | 'me' | 'partner';

function Wall({ view, report }: { view: WishesView; report: (t: SeenTarget) => void }) {
  const occasions = useOccasions().data ?? [];
  const [occasion, setOccasion] = useState<string>('all');
  const [giver, setGiver] = useState<Giver>('all');
  const shown = view.wall.filter(
    (g) =>
      (occasion === 'all' ||
        (occasion === 'none'
          ? g.occasion === null && g.anniversary === null
          : occasionValue(g) === occasion)) &&
      (giver === 'all' || (giver === 'me') === (g.giverId === view.me.id)),
  );
  return (
    <>
      <div className="mb-2 flex flex-wrap items-center gap-x-6 gap-y-3">
        <ToggleGroup
          type="single"
          aria-label="谁送的"
          value={giver}
          // A single toggle group turns its item off on a second click; one stays chosen.
          onValueChange={(value) => value && setGiver(value as Giver)}
        >
          <ToggleGroupItem value="all">全部</ToggleGroupItem>
          <ToggleGroupItem value="me">我送的</ToggleGroupItem>
          <ToggleGroupItem value="partner">TA 送的</ToggleGroupItem>
        </ToggleGroup>
        <label className="flex items-center gap-2 text-sm text-ink-soft">
          场合
          <NativeSelect
            className="h-9 w-auto"
            value={occasion}
            onChange={(e) => setOccasion(e.target.value)}
          >
            <option value="all">全部</option>
            <OccasionOptions gifts={view.wall} occasions={occasions} />
            <option value="none">未选</option>
          </NativeSelect>
        </label>
      </div>
      {shown.length ? (
        <ul>
          {shown.map((g) => (
            <WallGift key={g.id} gift={g} view={view} report={report} />
          ))}
        </ul>
      ) : (
        <p className="py-6 text-ink-soft">还没有礼物</p>
      )}
    </>
  );
}

function Note({
  note,
  view,
  report,
}: {
  note: WishesView['notes'][number];
  view: WishesView;
  report: (t: SeenTarget) => void;
}) {
  const ref = useSeen(
    note.unread ? { type: note.type, id: note.id, mark: note.mark } : null,
    report,
  );
  return (
    <li
      id={elementId('note', note.id)}
      ref={ref}
      className="rounded-xl bg-accent px-4 py-3 text-sm"
    >
      {view.partner.displayName} 删了"{note.name}"（
      {note.acted === 'prepared' ? '你在准备' : '你动过'}）· {dayText(note.deleted.at)}{' '}
      <UnreadLabel unread={note.unread ? 'new' : null} />
    </li>
  );
}

function TabDot({ on }: { on: boolean }) {
  return on ? (
    <span className="size-1.5 rounded-full bg-warm" role="img" aria-label="有新内容" />
  ) : null;
}

export function WishesPage() {
  const wishes = useWishes();
  const report = useSeenReporter(wishesKey);
  const [tab, setTab] = useState<Tab>('theirs');
  const view = wishes.data;
  if (wishes.isError)
    return (
      <Page>
        <p className={alertClass} role="alert">
          打不开心愿与礼物，请稍后再试
        </p>
        <Link to="/" className="mt-4 inline-block text-sm text-ink-soft underline">
          回到首页
        </Link>
      </Page>
    );
  if (!view) return <Page className="text-ink-soft">正在打开…</Page>;
  const unread = {
    theirs: view.theirs.filter((w) => w.unread).map((w) => elementId('wish', w.id)),
    mine: view.mine.filter((w) => w.unread).map((w) => elementId('wish', w.id)),
    wall: view.wall.filter((g) => g.unread || g.card?.unread).map((g) => elementId('gift', g.id)),
  };
  const tabOf = (id: string): Tab | null =>
    view.theirs.some((w) => elementId('wish', w.id) === id)
      ? 'theirs'
      : view.mine.some((w) => elementId('wish', w.id) === id)
        ? 'mine'
        : view.preparing.some((g) => elementId('gift', g.id) === id)
          ? 'preparing'
          : view.wall.some((g) => elementId('gift', g.id) === id)
            ? 'wall'
            : null;
  const reveal = (id: string) => {
    const owner = tabOf(id);
    if (owner) setTab(owner);
  };
  const show = (id: string) => {
    reveal(id);
    // The tab shows on the next render; scroll once it has.
    requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ block: 'center' }));
  };
  // In tab order, after the notes on top, so "下一处" walks through the tabs.
  const unreadIds = [
    ...view.notes.filter((n) => n.unread).map((n) => elementId('note', n.id)),
    ...unread.theirs,
    ...unread.mine,
    ...unread.wall,
  ];
  const partner = view.partner.displayName;
  return (
    <ShowRecord.Provider value={show}>
      <Page>
        <PageHeader
          title="心愿与礼物"
          description="把喜欢的小事，留给彼此。"
          actions={
            !view.readOnly && (
              <FormDialog
                trigger={
                  <Button>
                    <Plus aria-hidden="true" />
                    许个愿
                  </Button>
                }
                title="许个愿"
                submitText="许个愿"
                withNote
                send={(f, requestId) =>
                  callApi('createWish', { body: { requestId, ...wishBody(f) } }).then(() =>
                    setTab('mine'),
                  )
                }
              />
            )
          }
        />
        {view.readOnly && <ReadOnlyNotice />}
        <UnreadJump ids={unreadIds} show={reveal} />
        {view.notes.length > 0 && (
          <ul className="mb-6 grid gap-2">
            {view.notes.map((n) => (
              <Note key={n.id} note={n} view={view} report={report} />
            ))}
          </ul>
        )}
        <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)}>
          <TabsList aria-label="心愿与礼物">
            <TabsTrigger value="theirs">
              {partner} 的心愿 <TabDot on={unread.theirs.length > 0} />
            </TabsTrigger>
            <TabsTrigger value="mine">
              我的心愿 <TabDot on={unread.mine.length > 0} />
            </TabsTrigger>
            <TabsTrigger value="preparing">悄悄准备</TabsTrigger>
            <TabsTrigger value="wall">
              礼物墙 <TabDot on={unread.wall.length > 0} />
            </TabsTrigger>
          </TabsList>
          <TabsContent value="theirs" forceMount hidden={tab !== 'theirs'}>
            {view.theirs.length ? (
              <ul>
                {view.theirs.map((w) => (
                  <TheirWish key={w.id} wish={w} view={view} report={report} />
                ))}
              </ul>
            ) : (
              <p className="py-6 text-ink-soft">TA 还没有许愿</p>
            )}
          </TabsContent>
          <TabsContent value="mine" forceMount hidden={tab !== 'mine'}>
            {view.mine.length ? (
              <ul>
                {view.mine.map((w) => (
                  <MyWish key={w.id} wish={w} view={view} report={report} />
                ))}
              </ul>
            ) : (
              <p className="py-6 text-ink-soft">还没有许愿</p>
            )}
          </TabsContent>
          <TabsContent value="preparing" forceMount hidden={tab !== 'preparing'}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="flex items-center gap-2 text-sm text-ink-soft [&_svg]:size-4">
                <Lock aria-hidden="true" />
                这里的准备只有你看得到，TA 不会知道。
              </p>
              {!view.readOnly && (
                <FormDialog
                  trigger={
                    <Button variant="outline" size="sm">
                      <Plus aria-hidden="true" />
                      准备一份惊喜
                    </Button>
                  }
                  title="准备一份惊喜"
                  description="心愿单之外的礼物。揭晓之前，TA 看不到它。"
                  submitText="悄悄准备"
                  withNote={false}
                  send={(f, requestId) =>
                    callApi('prepareGift', {
                      body: {
                        requestId,
                        wishId: null,
                        name: f.name.trim(),
                        link: f.link.trim() || null,
                      },
                    })
                  }
                />
              )}
            </div>
            {view.preparing.length ? (
              <ul>
                {view.preparing.map((g) => (
                  <Preparing key={g.id} gift={g} view={view} report={report} />
                ))}
              </ul>
            ) : (
              <p className="py-6 text-ink-soft">还没有在准备的礼物</p>
            )}
          </TabsContent>
          <TabsContent value="wall" forceMount hidden={tab !== 'wall'}>
            <Wall view={view} report={report} />
          </TabsContent>
        </Tabs>
      </Page>
    </ShowRecord.Provider>
  );
}
