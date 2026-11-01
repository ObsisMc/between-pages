import { Link } from 'react-router';
import { homeLine } from './anniversary-line.ts';
import {
  browserZone,
  useClocks,
  useHomeAnniversary,
  useNow,
  useTimezoneReport,
} from './queries.ts';
import {
  asleepAt,
  awakeTogether,
  clockText,
  dayText,
  localDay,
  localParts,
  localToInstant,
  regionName,
  type DayPeriod,
  type Sleep,
} from './time.ts';
import './home-clocks.css';

// The home page's time area (opening-book-home D2, D5): the viewer's clock, and while the
// two are bound the partner's, today's shared awake hours on a timeline with "现在", and the
// anniversary line (anniversaries D3). Unbound, or after unbinding, nothing of the partner.

export const PERIOD_TEXT: Record<DayPeriod, string> = {
  dawn: '清晨',
  day: '白天',
  dusk: '傍晚',
  night: '夜里',
};

/** Counts down by the minute in the last day (partner-local-dates D3). */
function AnniversaryLine() {
  const found = useHomeAnniversary().data;
  const now = useNow(60_000);
  const line = found && homeLine(found.home, found.me, now);
  if (!found || !line) return null;
  return (
    <p className="anniversary-line">
      <Link to={`/anniversaries/${found.home.id}`}>{line.text}</Link>
      {line.wishes && (
        <>
          {' · '}
          <Link to="/wishes">看看 TA 的心愿</Link>
        </>
      )}
    </p>
  );
}

function Clock({
  who,
  now,
  zone,
  sleep,
}: {
  who: string;
  now: number;
  zone: string;
  sleep?: Sleep | null;
}) {
  return (
    <div className="clock-face">
      <p className="clock-who">{who}</p>
      <p className="clock-time">{clockText(now, zone)}</p>
      <p className="clock-day">
        {dayText(now, zone)} · {regionName(zone)}
        {sleep && asleepAt(now, zone, sleep) && ' · 大概在睡'}
      </p>
    </div>
  );
}

const TICKS = [0, 6, 12, 18, 24];

/**
 * The viewer's local today from 0:00 to 24:00 with every shared awake interval (none, one or
 * several) and "现在", which stays even outside them. The words say the same as the line, and
 * that it is worked out from sleep schedules, never that anyone is online.
 */
function AwakeTogether({
  now,
  zone,
  people,
}: {
  now: number;
  zone: string;
  people: { timezone: string | null; sleep: Sleep | null }[];
}) {
  const together = awakeTogether(now, zone, people);
  if (!together)
    return (
      <p className="awake-text">
        两人都设好作息后，这里会标出你们都醒着的时间 · <Link to="/clocks">设置作息</Link>
      </p>
    );
  const day = localDay(now, zone);
  const today = localParts(now, zone);
  const at = (instant: number) => ((instant - day.start) / (day.end - day.start)) * 100;
  const range = (start: number, end: number) =>
    `${clockText(start, zone, day.end)}–${clockText(end, zone, day.end)}`;
  return (
    <div className="awake">
      <p className="awake-text">
        {together.length
          ? `共同醒着 ${together.map((free) => range(free.start, free.end)).join('、')}`
          : '今天没有两人都醒着的时间'}{' '}
        · 按作息推算
      </p>
      <div className="awake-line" aria-hidden="true">
        {together.map((free) => (
          <span
            key={free.start}
            className="awake-span"
            style={{ left: `${at(free.start)}%`, width: `${at(free.end) - at(free.start)}%` }}
          />
        ))}
        {TICKS.map((hour) => (
          <span
            key={hour}
            className="awake-tick"
            style={{ left: `${at(localToInstant(today, hour * 60, zone))}%` }}
          >
            {hour}:00
          </span>
        ))}
        <span className="awake-now" style={{ left: `${at(now)}%` }}>
          <span>现在</span>
        </span>
      </div>
    </div>
  );
}

export function HomeClocks() {
  useTimezoneReport();
  const clocks = useClocks();
  const now = useNow();
  const zone = browserZone();
  const partner = clocks.data?.partner;
  // Nothing until the answer says whether there is a partner, so the heading never flips.
  if (clocks.isPending) return <section className="home-clocks" aria-busy="true" />;
  const me = { timezone: zone, sleep: clocks.data?.me.sleep ?? null };
  return (
    <section className="home-clocks" aria-labelledby="home-clocks-title">
      <h2 id="home-clocks-title">{partner ? '两地时间' : '此刻'}</h2>
      <div className="clock-pair">
        <Clock who="我这边" now={now} zone={zone} />
        {partner &&
          (partner.timezone ? (
            <Clock who="TA 那边" now={now} zone={partner.timezone} sleep={partner.sleep} />
          ) : (
            <p className="clock-face clock-missing">
              TA 还没打开过新版本，暂时看不到 TA 那边的时间
            </p>
          ))}
      </div>
      {partner && <AwakeTogether now={now} zone={zone} people={[me, partner]} />}
      {partner && <AnniversaryLine />}
    </section>
  );
}
