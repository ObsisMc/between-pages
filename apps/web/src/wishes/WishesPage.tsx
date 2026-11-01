import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { GiftOccasion } from '@between-pages/contracts';
import { callApi } from '../api/client.ts';
import {
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
  useWishes,
  useWrite,
  wishesKey,
  type Gift,
  type Wish,
  type WishesView,
} from './queries.ts';

// The wishes page (wishes-and-gifts ADR): both wish lists with links and hearts (D1), the
// caller's own gifts in preparation with their cards (D2, D3), revealing (D4), the gift wall
// with its date and occasion (D5), and notes of records the partner deleted (space-records
// D6). A gift in preparation exists only in the giver's answers, so nothing here hides it.

const OCCASIONS: Record<GiftOccasion, string> = {
  holiday: '节日',
  meeting: '见面',
  no_reason: '没什么理由',
};

const elementId = (type: string, id: string) => `${type}-${id}`;

function Hearts({
  value,
  onChange,
}: {
  value: number | null;
  onChange?: (want: number | null) => void;
}) {
  if (!onChange)
    return value ? (
      <span className="hearts" role="img" aria-label={`想要程度 ${value}/5`}>
        {'♥'.repeat(value)}
      </span>
    ) : null;
  return (
    <span className="hearts" role="group" aria-label="想要程度">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          className={value !== null && n <= value ? 'heart on' : 'heart'}
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
    <a className="link-preview" href={link} target="_blank" rel="noopener noreferrer">
      {preview?.image && !broken && (
        <img
          src={preview.image}
          alt=""
          referrerPolicy="no-referrer"
          onError={() => setBroken(true)}
        />
      )}
      <span>
        <span className="link-title">{title}</span>
        <span className="link-site">{preview?.site ?? hostOf(link)}</span>
      </span>
    </a>
  );
}

type Fields = { name: string; link: string; note: string; want: number | null };
const blank: Fields = { name: '', link: '', note: '', want: null };

function WishForm({
  initial = blank,
  submitText,
  withNote = true,
  onSubmit,
  onCancel,
}: {
  initial?: Fields;
  submitText: string;
  withNote?: boolean;
  onSubmit: (fields: Fields) => Promise<boolean>;
  onCancel?: () => void;
}) {
  const [fields, setFields] = useState(initial);
  const set = (patch: Partial<Fields>) => setFields((f) => ({ ...f, ...patch }));
  return (
    <form
      className="wish-form"
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit(fields).then((ok) => ok && !onCancel && setFields(blank));
      }}
    >
      <label>
        名称
        <input
          value={fields.name}
          maxLength={100}
          required
          onChange={(e) => set({ name: e.target.value })}
        />
      </label>
      <label>
        链接
        <input
          type="url"
          value={fields.link}
          placeholder="https://"
          onChange={(e) => set({ link: e.target.value })}
        />
      </label>
      {withNote && (
        <>
          <label>
            备注
            <input
              value={fields.note}
              maxLength={500}
              placeholder="尺码、颜色、哪个牌子都行"
              onChange={(e) => set({ note: e.target.value })}
            />
          </label>
          <Hearts value={fields.want} onChange={(want) => set({ want })} />
        </>
      )}
      <button type="submit" className="primary" disabled={!fields.name.trim()}>
        {submitText}
      </button>
      {onCancel && (
        <button type="button" onClick={onCancel}>
          取消
        </button>
      )}
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
    <li id={elementId(type, record.id)} ref={ref} className={className}>
      {children}
    </li>
  );
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
  const [editing, setEditing] = useState(false);
  const write = useWrite();
  const [deleteId, renewDelete] = useRequestId();
  const [receiveId, renewReceive] = useRequestId();
  return (
    <Record type="wish" record={wish} report={report} className="wish">
      {editing ? (
        <WishForm
          initial={{
            name: wish.name,
            link: wish.link ?? '',
            note: wish.note ?? '',
            want: wish.want,
          }}
          submitText="保存"
          onCancel={() => setEditing(false)}
          onSubmit={(f) =>
            write
              .run(() =>
                callApi('editWish', {
                  params: { wishId: wish.id },
                  body: { expectedRevision: wish.revision, ...wishBody(f) },
                }),
              )
              .then((ok) => (ok && setEditing(false), ok))
          }
        />
      ) : (
        <>
          <WishFace wish={wish} />
          {!view.readOnly && (
            <div className="actions">
              <button type="button" onClick={() => setEditing(true)}>
                编辑
              </button>
              <button
                type="button"
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
              </button>
              <button
                type="button"
                disabled={write.busy}
                onClick={() =>
                  window.confirm(`删除"${wish.name}"？`) &&
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
              </button>
            </div>
          )}
        </>
      )}
      {write.error && (
        <p className="notice" role="alert">
          {write.error}
        </p>
      )}
    </Record>
  );
}

function WishFace({ wish }: { wish: Wish }) {
  return (
    <>
      <p className="wish-name">
        {wish.name} <Hearts value={wish.want} /> <UnreadLabel unread={wish.unread} />
      </p>
      <LinkPreview link={wish.link} preview={wish.preview} />
      {wish.note && <p className="wish-note">{wish.note}</p>}
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
  return (
    <Record type="wish" record={wish} report={report} className="wish">
      <WishFace wish={wish} />
      {wish.preparingGiftId ? (
        <p className="secret">
          你在准备 · <a href={`#${elementId('gift', wish.preparingGiftId)}`}>写卡片、揭晓</a>
        </p>
      ) : (
        !view.readOnly && (
          <div className="actions">
            <button
              type="button"
              disabled={write.busy}
              onClick={() =>
                void write
                  .run(() => callApi('prepareGift', { body: { requestId, wishId: wish.id } }))
                  .then((ok) => ok && renew())
              }
            >
              我在准备
            </button>
          </div>
        )
      )}
      {write.error && (
        <p className="notice" role="alert">
          {write.error}
        </p>
      )}
    </Record>
  );
}

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
        {showCard && gift.card && <blockquote className="gift-card">{gift.card.text}</blockquote>}
        {!readOnly && (
          <button type="button" onClick={() => setOpen(true)}>
            {gift.card ? '改卡片' : '写卡片'}
          </button>
        )}
      </>
    );
  return (
    <form
      className="card-editor"
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
      <label>
        卡片
        <textarea value={text} maxLength={1000} onChange={(e) => setText(e.target.value)} />
      </label>
      <button type="submit" className="primary" disabled={!text.trim() || write.busy}>
        保存卡片
      </button>
      <button type="button" onClick={() => setOpen(false)}>
        取消
      </button>
      {write.error && (
        <p className="notice" role="alert">
          {write.error}
        </p>
      )}
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
      <p className="gift-name">
        {gift.name} <span className="secret">{forWish ? '心愿单上的' : '单外的惊喜'}</span>
      </p>
      <LinkPreview link={gift.link} preview={gift.preview} />
      <CardEditor gift={gift} readOnly={view.readOnly} />
      {!view.readOnly && (
        <div className="actions">
          <button
            type="button"
            className="primary"
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
          </button>
          <button
            type="button"
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
          </button>
        </div>
      )}
      {write.error && (
        <p className="notice" role="alert">
          {write.error}
        </p>
      )}
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
    <blockquote ref={ref} className="gift-card">
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
  const nameOf = (id: string) => (id === view.me.id ? '我' : view.partner.displayName);
  const fromMe = gift.giverId === view.me.id;
  const fresh = gift.unread === 'acted';
  return (
    <Record type="gift" record={gift} report={report} className="gift">
      <p className="gift-name">
        {gift.name} <UnreadLabel unread={gift.unread} />
      </p>
      <p className="gift-meta">
        {fromMe ? `我送给 ${view.partner.displayName}` : `${view.partner.displayName} 送给我`}
        {gift.date && ` · ${gift.date}`}
        {gift.occasion && ` · ${OCCASIONS[gift.occasion]}`}
      </p>
      <LinkPreview link={gift.link} preview={gift.preview} />
      {gift.card && <WallCard card={gift.card} report={report} />}
      <p className="stamps">
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
      {!view.readOnly && (
        <div className="actions">
          <label>
            日期
            <input
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
          </label>
          <label>
            场合
            <select
              value={gift.occasion ?? ''}
              onChange={(e) =>
                void write
                  .run(() =>
                    callApi('setGiftOccasion', {
                      params: { giftId: gift.id },
                      body: {
                        requestId: occasionId,
                        occasion: (e.target.value || null) as GiftOccasion | null,
                      },
                    }),
                  )
                  .then((ok) => ok && renewOccasion())
              }
            >
              <option value="">未选</option>
              {Object.entries(OCCASIONS).map(([value, text]) => (
                <option key={value} value={value}>
                  {text}
                </option>
              ))}
            </select>
          </label>
          {fromMe && <CardEditor gift={gift} readOnly={false} showCard={false} />}
          {gift.authorId === view.me.id && (
            <button
              type="button"
              disabled={write.busy}
              onClick={() =>
                window.confirm(`从礼物墙删除"${gift.name}"？`) &&
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
            </button>
          )}
        </div>
      )}
      {write.error && (
        <p className="notice" role="alert">
          {write.error}
        </p>
      )}
    </Record>
  );
}

function SurpriseForm() {
  const write = useWrite();
  const [requestId, renew] = useRequestId();
  return (
    <>
      <WishForm
        submitText="悄悄准备"
        withNote={false}
        onSubmit={(f) =>
          write
            .run(() =>
              callApi('prepareGift', {
                body: { requestId, wishId: null, name: f.name.trim(), link: f.link.trim() || null },
              }),
            )
            .then((ok) => (ok && renew(), ok))
        }
      />
      {write.error && (
        <p className="notice" role="alert">
          {write.error}
        </p>
      )}
    </>
  );
}

function NewWish() {
  const write = useWrite();
  const [requestId, renew] = useRequestId();
  return (
    <>
      <WishForm
        submitText="许个愿"
        onSubmit={(f) =>
          write
            .run(() => callApi('createWish', { body: { requestId, ...wishBody(f) } }))
            .then((ok) => (ok && renew(), ok))
        }
      />
      {write.error && (
        <p className="notice" role="alert">
          {write.error}
        </p>
      )}
    </>
  );
}

function Wall({ view, report }: { view: WishesView; report: (t: SeenTarget) => void }) {
  const [occasion, setOccasion] = useState<string>('all');
  const [giver, setGiver] = useState<'all' | 'me' | 'partner'>('all');
  const shown = view.wall.filter(
    (g) =>
      (occasion === 'all' ||
        (occasion === 'none' ? g.occasion === null : g.occasion === occasion)) &&
      (giver === 'all' || (giver === 'me') === (g.giverId === view.me.id)),
  );
  return (
    <section>
      <h2>礼物墙</h2>
      <p className="filters">
        <label>
          场合
          <select value={occasion} onChange={(e) => setOccasion(e.target.value)}>
            <option value="all">全部</option>
            {Object.entries(OCCASIONS).map(([value, text]) => (
              <option key={value} value={value}>
                {text}
              </option>
            ))}
            <option value="none">未选</option>
          </select>
        </label>
        <label>
          谁送的
          <select value={giver} onChange={(e) => setGiver(e.target.value as typeof giver)}>
            <option value="all">全部</option>
            <option value="me">我送的</option>
            <option value="partner">TA 送的</option>
          </select>
        </label>
      </p>
      {shown.length ? (
        <ul className="records">
          {shown.map((g) => (
            <WallGift key={g.id} gift={g} view={view} report={report} />
          ))}
        </ul>
      ) : (
        <p className="empty">还没有礼物</p>
      )}
    </section>
  );
}

export function WishesPage() {
  const wishes = useWishes();
  const report = useSeenReporter(wishesKey);
  const view = wishes.data;
  if (wishes.isError)
    return (
      <main className="page wishes">
        <p className="notice" role="alert">
          打不开心愿与礼物，请稍后再试
        </p>
        <Link to="/">回到首页</Link>
      </main>
    );
  if (!view) return <main className="page wishes">正在打开…</main>;
  const unreadIds = [
    ...view.notes.filter((n) => n.unread).map((n) => elementId('note', n.id)),
    ...view.mine.filter((w) => w.unread).map((w) => elementId('wish', w.id)),
    ...view.theirs.filter((w) => w.unread).map((w) => elementId('wish', w.id)),
    ...view.wall.filter((g) => g.unread || g.card?.unread).map((g) => elementId('gift', g.id)),
  ];
  return (
    <main className="page wishes">
      <header>
        <Link to="/">← 首页</Link>
      </header>
      <h1>心愿与礼物</h1>
      {view.readOnly && <ReadOnlyNotice />}
      <UnreadJump ids={unreadIds} />
      {view.notes.length > 0 && (
        <ul className="records notes">
          {view.notes.map((n) => (
            <Note key={n.id} note={n} view={view} report={report} />
          ))}
        </ul>
      )}
      <section>
        <h2>我的心愿</h2>
        {!view.readOnly && <NewWish />}
        <ul className="records">
          {view.mine.map((w) => (
            <MyWish key={w.id} wish={w} view={view} report={report} />
          ))}
        </ul>
      </section>
      <section>
        <h2>{view.partner.displayName} 的心愿</h2>
        {view.theirs.length ? (
          <ul className="records">
            {view.theirs.map((w) => (
              <TheirWish key={w.id} wish={w} view={view} report={report} />
            ))}
          </ul>
        ) : (
          <p className="empty">TA 还没有许愿</p>
        )}
      </section>
      <section>
        <h2>
          我在准备 <span className="secret">只有你看得到</span>
        </h2>
        {!view.readOnly && <SurpriseForm />}
        <ul className="records">
          {view.preparing.map((g) => (
            <Preparing key={g.id} gift={g} view={view} report={report} />
          ))}
        </ul>
      </section>
      <Wall view={view} report={report} />
    </main>
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
    <li id={elementId('note', note.id)} ref={ref} className="note">
      {view.partner.displayName} 删了"{note.name}"（
      {note.acted === 'prepared' ? '你在准备' : '你动过'}）· {dayText(note.deleted.at)}{' '}
      <UnreadLabel unread={note.unread ? 'new' : null} />
    </li>
  );
}
