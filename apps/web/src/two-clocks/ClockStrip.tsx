import { Link } from 'react-router';
import { homeLine } from './anniversary-line.ts';
import { useClocks, useHomeAnniversary, useNow, useTimezoneReport } from './queries.ts';
import { asleepAt, clockText, dayPeriod, regionName, type DayPeriod, type Sleep } from './time.ts';

// The home strip (two-clocks D4): the partner's local time, the zone's region and a tint by
// the hour there, and the anniversary line (anniversaries D3), only while the two are bound.
// The next-meeting line joins it when that feature lands.

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

function PartnerClock({ timezone, sleep }: { timezone: string | null; sleep: Sleep | null }) {
  const now = useNow();
  if (!timezone)
    return (
      <p className="clock-strip">
        TA 还没打开过新版本，暂时看不到 TA 那边的时间 · <Link to="/clocks">两地时间</Link>
      </p>
    );
  const period = dayPeriod(now, timezone);
  const asleep = sleep && asleepAt(now, timezone, sleep);
  return (
    <p className={`clock-strip period-${period}`}>
      TA 那边 <strong>{clockText(now, timezone)}</strong> · {PERIOD_TEXT[period]} ·{' '}
      {regionName(timezone)}
      {asleep && ' · 大概在睡'} · <Link to="/clocks">两地时间</Link>
    </p>
  );
}

export function ClockStrip() {
  useTimezoneReport();
  const partner = useClocks().data?.partner;
  if (!partner) return null;
  return (
    <>
      <PartnerClock timezone={partner.timezone} sleep={partner.sleep} />
      <AnniversaryLine />
    </>
  );
}
