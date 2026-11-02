import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
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
  anniversariesKey,
  useAnniversaries,
  useWrite,
  zone,
  type Anniversary,
  type AnniversariesView,
} from './queries.ts';
import { BASIS_TEXT, REMINDERS, countdownText, dateText, nameOf, nextText } from './text.ts';

// The anniversaries page (anniversaries ADR): every anniversary soonest first with its next
// day counted in its basis zone (partner-local-dates D1), "第 N 天" when counting (D2), the
// caller's own reminder (D3), the date and the count either may change (D7), and notes of
// ones the partner deleted (space-records D6).

type Kind = Anniversary['kind'];
const elementId = (type: string, id: string) => `${type}-${id}`;

function Record({
  record,
  report,
  children,
}: {
  record: Anniversary;
  report: (t: SeenTarget) => void;
  children: ReactNode;
}) {
  const ref = useSeen(
    record.unread ? { type: 'anniversary', id: record.id, mark: record.mark } : null,
    report,
  );
  return (
    <li id={elementId('anniversary', record.id)} ref={ref} className="anniversary">
      {children}
    </li>
  );
}

const isoOf = (y: number, m: number, d: number) =>
  `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const fromIso = (iso: string) => {
  const [year, month, day] = iso.split('-').map(Number) as [number, number, number];
  return { year, month, day };
};

/** A date, with "不记年份" for a birthday (D1); a birthday without a year keeps 2 月 29 日. */
function DateInput({
  value,
  yearOptional,
  onChange,
}: {
  value: { year: number | null; month: number; day: number };
  yearOptional: boolean;
  onChange: (date: { year: number | null; month: number; day: number }) => void;
}) {
  // A leap year holds every month and day when the year is not kept.
  const shown = isoOf(value.year ?? 2000, value.month, value.day);
  return (
    <>
      <label>
        日期
        <input
          type="date"
          value={shown}
          required
          onChange={(e) => {
            if (!e.target.value) return;
            const picked = fromIso(e.target.value);
            onChange({ ...picked, year: value.year === null ? null : picked.year });
          }}
        />
      </label>
      {yearOptional && (
        <label className="inline">
          <input
            type="checkbox"
            checked={value.year === null}
            onChange={(e) =>
              onChange({ ...value, year: e.target.checked ? null : new Date().getFullYear() })
            }
          />
          不记年份
        </label>
      )}
    </>
  );
}

function NewAnniversary({ view }: { view: AnniversariesView }) {
  const write = useWrite();
  const [requestId, renew] = useRequestId();
  const today = new Date();
  const blank = {
    kind: 'birthday' as Kind,
    whose: view.partner.id,
    name: '',
    note: '',
    date: {
      year: today.getFullYear() as number | null,
      month: today.getMonth() + 1,
      day: today.getDate(),
    },
  };
  const [f, setF] = useState(blank);
  const hasTogether = view.anniversaries.some((a) => a.kind === 'together');
  return (
    <form
      className="anniversary-form"
      onSubmit={(event) => {
        event.preventDefault();
        void write
          .run(() =>
            callApi('createAnniversary', {
              query: { timezone: zone() },
              body: {
                requestId,
                kind: f.kind,
                birthdayOf: f.kind === 'birthday' ? f.whose : null,
                name: f.kind === 'other' ? f.name.trim() : null,
                note: f.note.trim() || null,
                ...f.date,
                year: f.kind === 'birthday' ? f.date.year : (f.date.year ?? today.getFullYear()),
              },
            }),
          )
          .then((ok) => ok && (renew(), setF(blank)));
      }}
    >
      <label>
        种类
        <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as Kind })}>
          <option value="birthday">生日</option>
          {!hasTogether && <option value="together">在一起的日子</option>}
          <option value="other">其他</option>
        </select>
      </label>
      {f.kind === 'birthday' && (
        <label>
          谁的
          <select value={f.whose} onChange={(e) => setF({ ...f, whose: e.target.value })}>
            <option value={view.partner.id}>{view.partner.displayName}</option>
            <option value={view.me.id}>我</option>
          </select>
        </label>
      )}
      {f.kind === 'other' && (
        <label>
          名称
          <input
            value={f.name}
            maxLength={30}
            required
            placeholder="第一次见面"
            onChange={(e) => setF({ ...f, name: e.target.value })}
          />
        </label>
      )}
      <DateInput
        value={f.date}
        yearOptional={f.kind === 'birthday'}
        onChange={(date) => setF({ ...f, date })}
      />
      <label>
        备注
        <input
          value={f.note}
          maxLength={200}
          onChange={(e) => setF({ ...f, note: e.target.value })}
        />
      </label>
      <button
        type="submit"
        className="primary"
        disabled={write.busy || (f.kind === 'other' && !f.name.trim())}
      >
        记下
      </button>
      {write.error && (
        <p className="notice" role="alert">
          {write.error}
        </p>
      )}
    </form>
  );
}

/** The next day, counted down; the basis said where it is not the caller's own. */
export function NextDay({ a, now }: { a: Anniversary; now: number }) {
  const basis = BASIS_TEXT[a.basis];
  return (
    <p className="anniversary-next">
      {a.next.date.replaceAll('-', ' / ')} · {nextText(a)} ·{' '}
      <strong>{countdownText(a, now)}</strong>
      {basis && <span className="basis"> · {basis}</span>}
    </p>
  );
}

function Item({
  a,
  view,
  now,
  report,
}: {
  a: Anniversary;
  view: AnniversariesView;
  now: number;
  report: (t: SeenTarget) => void;
}) {
  const write = useWrite();
  const [dateId, renewDate] = useRequestId();
  const [countId, renewCount] = useRequestId();
  const [deleteId, renewDelete] = useRequestId();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(a.name ?? '');
  const [note, setNote] = useState(a.note ?? '');
  const mine = a.authorId === view.me.id;
  const fresh = a.unread === 'acted';
  const person = (id: string) => (id === view.me.id ? '我' : view.partner.displayName);
  const params = { anniversaryId: a.id };
  const query = { timezone: zone() };
  return (
    <Record record={a} report={report}>
      <p className="anniversary-name">
        <Link to={`/anniversaries/${a.id}`}>{nameOf(a, view)}</Link> · {dateText(a)}{' '}
        <UnreadLabel unread={a.unread} />
      </p>
      {a.dayCount && (
        <p className="day-count">
          {a.kind === 'together' ? '在一起' : ''}第 {a.dayCount} 天
        </p>
      )}
      <NextDay a={a} now={now} />
      {a.note && <p className="anniversary-note">{a.note}</p>}
      <p className="stamps">
        {a.dateSet && (
          <StampText name={person(a.dateSet.by)} verb="改了日期" at={a.dateSet.at} fresh={fresh} />
        )}
        {a.countSet && (
          <StampText
            name={person(a.countSet.by)}
            verb={a.showCount ? '打开了计数' : '关闭了计数'}
            at={a.countSet.at}
            fresh={fresh}
          />
        )}
      </p>
      <div className="actions">
        <label>
          提醒我
          <select
            value={String(a.reminder)}
            onChange={(e) =>
              void write.run(() =>
                callApi('saveAnniversaryReminder', {
                  params,
                  query,
                  body: { days: REMINDERS[e.target.selectedIndex]!.value },
                }),
              )
            }
          >
            {REMINDERS.map((r) => (
              <option key={String(r.value)} value={String(r.value)}>
                {r.text}
              </option>
            ))}
          </select>
        </label>
        {!view.readOnly && (
          <>
            <DateInput
              value={a}
              yearOptional={a.kind === 'birthday' && !a.showCount}
              onChange={(date) =>
                void write
                  .run(() =>
                    callApi('setAnniversaryDate', {
                      params,
                      query,
                      body: { requestId: dateId, ...date },
                    }),
                  )
                  .then((ok) => ok && renewDate())
              }
            />
            {a.year !== null && (
              <label className="inline">
                <input
                  type="checkbox"
                  checked={a.showCount}
                  onChange={(e) =>
                    void write
                      .run(() =>
                        callApi('setAnniversaryCount', {
                          params,
                          query,
                          body: { requestId: countId, showCount: e.target.checked },
                        }),
                      )
                      .then((ok) => ok && renewCount())
                  }
                />
                显示第 N 天
              </label>
            )}
            {mine && !editing && (
              <button type="button" onClick={() => setEditing(true)}>
                编辑
              </button>
            )}
            {mine && (
              <button
                type="button"
                disabled={write.busy}
                onClick={() =>
                  window.confirm(`删除"${nameOf(a, view)}"？`) &&
                  void write
                    .run(() =>
                      callApi('deleteAnniversary', { params, body: { requestId: deleteId } }),
                    )
                    .then((ok) => ok && renewDelete())
                }
              >
                删除
              </button>
            )}
          </>
        )}
      </div>
      {editing && (
        <form
          className="anniversary-form"
          onSubmit={(event) => {
            event.preventDefault();
            void write
              .run(() =>
                callApi('editAnniversary', {
                  params,
                  query,
                  body: {
                    expectedRevision: a.revision,
                    kind: a.kind,
                    birthdayOf: a.birthdayOf,
                    name: a.kind === 'other' ? name.trim() : null,
                    note: note.trim() || null,
                  },
                }),
              )
              .then((ok) => ok && setEditing(false));
          }}
        >
          {a.kind === 'other' && (
            <label>
              名称
              <input
                value={name}
                maxLength={30}
                required
                onChange={(e) => setName(e.target.value)}
              />
            </label>
          )}
          <label>
            备注
            <input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
          </label>
          <button type="submit" className="primary">
            保存
          </button>
          <button type="button" onClick={() => setEditing(false)}>
            取消
          </button>
        </form>
      )}
      {write.error && (
        <p className="notice" role="alert">
          {write.error}
        </p>
      )}
    </Record>
  );
}

function Note({
  note,
  view,
  report,
}: {
  note: AnniversariesView['notes'][number];
  view: AnniversariesView;
  report: (t: SeenTarget) => void;
}) {
  const ref = useSeen(
    note.unread ? { type: 'anniversary', id: note.id, mark: note.mark } : null,
    report,
  );
  return (
    <li id={elementId('note', note.id)} ref={ref} className="note">
      {view.partner.displayName} 删了"{nameOf(note, view)}"（你动过）· {dayText(note.deleted.at)}{' '}
      <UnreadLabel unread={note.unread ? 'new' : null} />
    </li>
  );
}

/** The current time, moving every minute so the last day counts down (partner-local-dates D3). */
export function useMinute(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export function AnniversariesPage() {
  const anniversaries = useAnniversaries();
  const report = useSeenReporter(anniversariesKey);
  const now = useMinute();
  const view = anniversaries.data;
  if (anniversaries.isError)
    return (
      <main className="page anniversaries">
        <p className="notice" role="alert">
          打不开纪念日，请稍后再试
        </p>
        <Link to="/">回到首页</Link>
      </main>
    );
  if (!view) return <main className="page anniversaries">正在打开…</main>;
  const unreadIds = [
    ...view.notes.filter((n) => n.unread).map((n) => elementId('note', n.id)),
    ...view.anniversaries.filter((a) => a.unread).map((a) => elementId('anniversary', a.id)),
  ];
  return (
    <main className="page anniversaries">
      <header>
        <Link to="/">← 首页</Link>
      </header>
      <h1>纪念日</h1>
      {view.readOnly && <ReadOnlyNotice />}
      <UnreadJump ids={unreadIds} />
      {view.notes.length > 0 && (
        <ul className="records notes">
          {view.notes.map((n) => (
            <Note key={n.id} note={n} view={view} report={report} />
          ))}
        </ul>
      )}
      {!view.readOnly && <NewAnniversary view={view} />}
      {view.anniversaries.length ? (
        <ul className="records">
          {view.anniversaries.map((a) => (
            <Item key={a.id} a={a} view={view} now={now} report={report} />
          ))}
        </ul>
      ) : (
        <p className="empty">还没有纪念日</p>
      )}
    </main>
  );
}
