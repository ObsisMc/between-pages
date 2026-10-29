import { Link } from 'react-router';
import { useClocks, useNow, useTimezoneReport } from './queries.ts';
import { asleepAt, clockText, dayPeriod, regionName, type DayPeriod } from './time.ts';

// The home strip (two-clocks D4): the partner's local time, the zone's region and a tint by
// the hour there, only while the two are bound. The next-meeting and anniversary lines join
// it when those features land.

export const PERIOD_TEXT: Record<DayPeriod, string> = {
  dawn: '清晨',
  day: '白天',
  dusk: '傍晚',
  night: '夜里',
};

export function ClockStrip() {
  useTimezoneReport();
  const partner = useClocks().data?.partner;
  const now = useNow();
  if (!partner) return null;
  if (!partner.timezone)
    return (
      <p className="clock-strip">
        TA 还没打开过新版本，暂时看不到 TA 那边的时间 · <Link to="/clocks">两地时间</Link>
      </p>
    );
  const period = dayPeriod(now, partner.timezone);
  const asleep = partner.sleep && asleepAt(now, partner.timezone, partner.sleep);
  return (
    <p className={`clock-strip period-${period}`}>
      TA 那边 <strong>{clockText(now, partner.timezone)}</strong> · {PERIOD_TEXT[period]} ·{' '}
      {regionName(partner.timezone)}
      {asleep && ' · 大概在睡'} · <Link to="/clocks">两地时间</Link>
    </p>
  );
}
