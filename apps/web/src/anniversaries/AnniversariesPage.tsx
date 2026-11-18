import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { ChevronDown, Plus } from 'lucide-react';
import { callApi } from '../api/client.ts';
import { Page, PageHeader } from '../shell/index.ts';
import {
  Button,
  CheckboxLabel,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  DialogTrigger,
  Input,
  Label,
  NativeSelect,
  cn,
} from '../ui/index.ts';
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
// ones the partner deleted (space-records D6). The together day leads the page
// (digital-paper-interface D3); the shared changes fold under "修改".

type Kind = Anniversary['kind'];
const elementId = (type: string, id: string) => `${type}-${id}`;

function Record({
  record,
  report,
  className,
  children,
}: {
  record: Anniversary;
  report: (t: SeenTarget) => void;
  className: string;
  children: ReactNode;
}) {
  const ref = useSeen(
    record.unread ? { type: 'anniversary', id: record.id, mark: record.mark } : null,
    report,
  );
  return (
    <li id={elementId('anniversary', record.id)} ref={ref} className={cn('anniversary', className)}>
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
      <Label>
        日期
        <Input
          type="date"
          value={shown}
          required
          onChange={(e) => {
            if (!e.target.value) return;
            const picked = fromIso(e.target.value);
            onChange({ ...picked, year: value.year === null ? null : picked.year });
          }}
        />
      </Label>
      {yearOptional && (
        <CheckboxLabel>
          <input
            type="checkbox"
            checked={value.year === null}
            onChange={(e) =>
              onChange({ ...value, year: e.target.checked ? null : new Date().getFullYear() })
            }
          />
          不记年份
        </CheckboxLabel>
      )}
    </>
  );
}

const alertClass = 'rounded-xl bg-notice px-4 py-3 text-sm text-ink';

/** "记下一天": the form in a dialog; what was typed stays when it is closed unsent. */
function NewAnniversary({ view }: { view: AnniversariesView }) {
  const write = useWrite();
  const [requestId, renew] = useRequestId();
  const [open, setOpen] = useState(false);
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
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <Plus aria-hidden="true" />
          记下一天
        </Button>
      </DialogTrigger>
      <DialogContent aria-describedby={undefined}>
        <DialogTitle>记下一天</DialogTitle>
        <form
          className="grid gap-4"
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
                    year:
                      f.kind === 'birthday' ? f.date.year : (f.date.year ?? today.getFullYear()),
                  },
                }),
              )
              .then((ok) => ok && (renew(), setF(blank), setOpen(false)));
          }}
        >
          <Label>
            种类
            <NativeSelect
              value={f.kind}
              onChange={(e) => setF({ ...f, kind: e.target.value as Kind })}
            >
              <option value="birthday">生日</option>
              {!hasTogether && <option value="together">在一起的日子</option>}
              <option value="other">其他</option>
            </NativeSelect>
          </Label>
          {f.kind === 'birthday' && (
            <Label>
              谁的
              <NativeSelect value={f.whose} onChange={(e) => setF({ ...f, whose: e.target.value })}>
                <option value={view.partner.id}>{view.partner.displayName}</option>
                <option value={view.me.id}>我</option>
              </NativeSelect>
            </Label>
          )}
          {f.kind === 'other' && (
            <Label>
              名称
              <Input
                value={f.name}
                maxLength={30}
                required
                placeholder="第一次见面"
                onChange={(e) => setF({ ...f, name: e.target.value })}
              />
            </Label>
          )}
          <DateInput
            value={f.date}
            yearOptional={f.kind === 'birthday'}
            onChange={(date) => setF({ ...f, date })}
          />
          <Label>
            备注
            <Input
              value={f.note}
              maxLength={200}
              onChange={(e) => setF({ ...f, note: e.target.value })}
            />
          </Label>
          {write.error && (
            <p className={alertClass} role="alert">
              {write.error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button type="button" variant="ghost">
                取消
              </Button>
            </DialogClose>
            <Button type="submit" disabled={write.busy || (f.kind === 'other' && !f.name.trim())}>
              记下
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The next day, counted down; the basis said where it is not the caller's own. */
export function NextDay({ a, now }: { a: Anniversary; now: number }) {
  const basis = BASIS_TEXT[a.basis];
  return (
    <p className="mt-1 text-sm text-ink-soft">
      {a.next.date.replaceAll('-', ' / ')} · {nextText(a)} ·{' '}
      <strong className="font-medium text-warm">{countdownText(a, now)}</strong>
      {basis && <span> · {basis}</span>}
    </p>
  );
}

/** The day of the year an anniversary falls on, as the row's mark. */
function DateMark({ a }: { a: Anniversary }) {
  return (
    <p className="w-14 shrink-0 text-center" aria-hidden="true">
      <span className="block text-xs text-ink-soft">{a.month} 月</span>
      <span className="block font-serif text-3xl leading-tight tabular-nums">
        {String(a.day).padStart(2, '0')}
      </span>
    </p>
  );
}

function Item({
  a,
  view,
  now,
  report,
  lead = false,
}: {
  a: Anniversary;
  view: AnniversariesView;
  now: number;
  report: (t: SeenTarget) => void;
  /** The together day, at the top of the page. */
  lead?: boolean;
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
    <Record
      record={a}
      report={report}
      className={lead ? 'mb-4 rounded-2xl bg-accent p-6' : 'border-b border-line py-6'}
    >
      <div className="flex gap-4">
        {!lead && <DateMark a={a} />}
        <div className="min-w-0 flex-1">
          {lead && (
            <p className="mb-2 text-xs tracking-widest text-ink-soft">从 {dateText(a)} 开始</p>
          )}
          <p className="font-serif text-xl">
            <Link to={`/anniversaries/${a.id}`} className="underline-offset-4 hover:underline">
              {nameOf(a, view)}
            </Link>
            {!lead && <span className="font-sans text-sm text-ink-soft"> · {dateText(a)}</span>}{' '}
            <UnreadLabel unread={a.unread} />
          </p>
          {a.dayCount &&
            (lead ? (
              <p className="mt-2 font-serif text-ink-soft">
                {a.kind === 'together' ? '在一起' : ''}第{' '}
                <span className="text-5xl text-warm tabular-nums">{a.dayCount}</span> 天
              </p>
            ) : (
              <p className="mt-1 font-serif">
                {a.kind === 'together' ? '在一起' : ''}第 {a.dayCount} 天
              </p>
            ))}
          <NextDay a={a} now={now} />
          {a.note && <p className="mt-1 text-sm text-ink-soft">{a.note}</p>}
          {(a.dateSet || a.countSet) && (
            <p className="mt-1">
              {a.dateSet && (
                <StampText
                  name={person(a.dateSet.by)}
                  verb="改了日期"
                  at={a.dateSet.at}
                  fresh={fresh}
                />
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
          )}
          <Collapsible className="mt-3">
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-sm text-ink-soft">
                提醒我
                <NativeSelect
                  className="h-9 w-auto"
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
                </NativeSelect>
              </label>
              {!view.readOnly && (
                <CollapsibleTrigger asChild>
                  <Button variant="ghost" size="sm" className="group text-ink-soft">
                    修改
                    <ChevronDown
                      aria-hidden="true"
                      className="transition-transform group-data-[state=open]:rotate-180"
                    />
                  </Button>
                </CollapsibleTrigger>
              )}
            </div>
            {!view.readOnly && (
              <CollapsibleContent className="mt-4 grid gap-4 rounded-xl border border-line p-4">
                <div className="flex flex-wrap items-end gap-4">
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
                    <CheckboxLabel className="h-11">
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
                    </CheckboxLabel>
                  )}
                </div>
                {mine && (
                  <div className="flex flex-wrap gap-2">
                    {!editing && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setEditing(true)}
                      >
                        编辑
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={write.busy}
                      onClick={() =>
                        window.confirm(`删除"${nameOf(a, view)}"？${COPY_STAYS_NOTE}`) &&
                        void write
                          .run(() =>
                            callApi('deleteAnniversary', { params, body: { requestId: deleteId } }),
                          )
                          .then((ok) => ok && renewDelete())
                      }
                    >
                      删除
                    </Button>
                  </div>
                )}
                {editing && (
                  <form
                    className="grid gap-4"
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
                      <Label>
                        名称
                        <Input
                          value={name}
                          maxLength={30}
                          required
                          onChange={(e) => setName(e.target.value)}
                        />
                      </Label>
                    )}
                    <Label>
                      备注
                      <Input
                        value={note}
                        maxLength={200}
                        onChange={(e) => setNote(e.target.value)}
                      />
                    </Label>
                    <div className="flex gap-2">
                      <Button type="submit" size="sm">
                        保存
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setEditing(false)}
                      >
                        取消
                      </Button>
                    </div>
                  </form>
                )}
              </CollapsibleContent>
            )}
          </Collapsible>
          {write.error && (
            <p className={cn(alertClass, 'mt-3')} role="alert">
              {write.error}
            </p>
          )}
        </div>
      </div>
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
    <li
      id={elementId('note', note.id)}
      ref={ref}
      className="rounded-xl bg-accent px-4 py-3 text-sm"
    >
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
      <Page>
        <p className={alertClass} role="alert">
          打不开纪念日，请稍后再试
        </p>
        <Link to="/" className="mt-4 inline-block text-sm text-ink-soft underline">
          回到首页
        </Link>
      </Page>
    );
  if (!view) return <Page className="text-ink-soft">正在打开…</Page>;
  const lead = view.anniversaries.find((a) => a.kind === 'together');
  const rest = view.anniversaries.filter((a) => a !== lead);
  // In page order, so "下一处" walks down the page.
  const unreadIds = [
    ...view.notes.filter((n) => n.unread).map((n) => elementId('note', n.id)),
    ...[...(lead ? [lead] : []), ...rest]
      .filter((a) => a.unread)
      .map((a) => elementId('anniversary', a.id)),
  ];
  return (
    <Page>
      <PageHeader
        title="纪念日"
        description="有些日子，每年都想和你再过一次。"
        actions={!view.readOnly && <NewAnniversary view={view} />}
      />
      {view.readOnly && <ReadOnlyNotice />}
      <UnreadJump ids={unreadIds} />
      {view.notes.length > 0 && (
        <ul className="mb-6 grid gap-2">
          {view.notes.map((n) => (
            <Note key={n.id} note={n} view={view} report={report} />
          ))}
        </ul>
      )}
      {view.anniversaries.length ? (
        <ul>
          {lead && <Item key={lead.id} a={lead} view={view} now={now} report={report} lead />}
          {rest.map((a) => (
            <Item key={a.id} a={a} view={view} now={now} report={report} />
          ))}
        </ul>
      ) : (
        <p className="text-ink-soft">还没有纪念日</p>
      )}
    </Page>
  );
}
