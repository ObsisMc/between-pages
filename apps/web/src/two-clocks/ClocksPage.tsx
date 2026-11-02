import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { callApi } from '../api/client.ts';
import { BookSpread } from '../book/index.ts';
import { PERIOD_TEXT } from './HomeClocks.tsx';
import { browserZone, clocksKey, useClocks, useNow, useTimezoneReport } from './queries.ts';
import {
  awakeTogether,
  clockText,
  dayPeriod,
  localDay,
  minuteText,
  regionName,
  type Sleep,
} from './time.ts';

// The clocks page (two-clocks D2, D3): both local times, both sleep schedules (only the
// caller's editable) and today's hours when both are awake, each in its own local time.
// Without a current binding it shows nothing of anyone (D5). The clocks are the left page,
// the schedules the right (book-surface D5).

const STEPS = Array.from({ length: 96 }, (_, i) => i * 15);

function SleepEditor({ sleep }: { sleep: Sleep | null }) {
  const client = useQueryClient();
  const [start, setStart] = useState(sleep?.start ?? 0);
  const [end, setEnd] = useState(sleep?.end ?? 480);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const save = async (next: Sleep | null) => {
    setFailed(false);
    setSaving(true);
    try {
      const me = await callApi('saveSleep', { body: { sleep: next } });
      client.setQueryData(clocksKey, (old) => old && { ...old, me });
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };
  const select = (label: string, value: number, set: (minute: number) => void) => (
    <label>
      {label}
      <select value={value} onChange={(event) => set(Number(event.target.value))}>
        {STEPS.map((minute) => (
          <option key={minute} value={minute}>
            {minuteText(minute)}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <form
      className="sleep-editor"
      onSubmit={(event) => {
        event.preventDefault();
        void save({ start, end });
      }}
    >
      {select('入睡', start, setStart)}
      {select('起床', end, setEnd)}
      <button type="submit" disabled={saving || start === end}>
        保存作息
      </button>
      {sleep && (
        <button type="button" disabled={saving} onClick={() => void save(null)}>
          清除
        </button>
      )}
      {failed && (
        <p className="notice" role="alert">
          没有保存成功，请稍后再试
        </p>
      )}
    </form>
  );
}

const sleepText = (sleep: Sleep | null) =>
  sleep ? `${minuteText(sleep.start)}–${minuteText(sleep.end)}` : '还没设';

export function ClocksPage() {
  useTimezoneReport();
  const clocks = useClocks();
  const now = useNow();
  const partner = clocks.data?.partner;
  const zone = browserZone();

  if (clocks.isPending)
    return (
      <main className="clocks">
        <BookSpread left={null} right={null} />
      </main>
    );
  if (!partner)
    return (
      <main className="clocks">
        <BookSpread
          left={
            <>
              <Link className="book-back" to="/">
                ← 序言
              </Link>
              <h1>两地时间</h1>
              <p>绑定搭档后，这里会显示你们两边的时间。</p>
            </>
          }
          right={null}
        />
      </main>
    );

  const me = { timezone: zone, sleep: clocks.data!.me.sleep };
  const day = localDay(now, zone);
  const together = awakeTogether(now, zone, [me, partner]);
  const side = (who: string, timezone: string | null) =>
    timezone ? (
      <p className={`clock period-${dayPeriod(now, timezone)}`}>
        {who} <strong>{clockText(now, timezone)}</strong> · {PERIOD_TEXT[dayPeriod(now, timezone)]}{' '}
        · {regionName(timezone)}
      </p>
    ) : (
      <p className="clock">{who}：TA 还没打开过新版本</p>
    );

  return (
    <main className="clocks">
      <BookSpread
        left={
          <>
            <Link className="book-back" to="/">
              ← 序言
            </Link>
            <h1>两地时间</h1>
            <section>
              {side('你这边', zone)}
              {side('TA 那边', partner.timezone)}
            </section>
            <section>
              <h2>今天你们都醒着的时间</h2>
              {together === null ? (
                <p>两人都设好作息后，会显示今天你们都醒着的时间。</p>
              ) : together.length === 0 ? (
                <p>今天没有两人都醒着的时间。</p>
              ) : (
                <ul className="awake-together">
                  {together.map((free) => (
                    <li key={free.start}>
                      你 {clockText(free.start, zone, day.end)}–{clockText(free.end, zone, day.end)}{' '}
                      · TA {clockText(free.start, partner.timezone!)}–
                      {clockText(free.end, partner.timezone!)}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        }
        right={
          <section>
            <h2>作息</h2>
            <p>你平时 {sleepText(me.sleep)} 睡</p>
            <SleepEditor key={JSON.stringify(me.sleep)} sleep={me.sleep} />
            <p>TA 平时 {sleepText(partner.sleep)} 睡</p>
          </section>
        }
      />
    </main>
  );
}
