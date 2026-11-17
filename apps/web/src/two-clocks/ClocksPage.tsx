import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Moon, Sun, Sunrise, Sunset, type LucideIcon } from 'lucide-react';
import { callApi } from '../api/client.ts';
import { Page, PageHeader, SectionTitle } from '../shell/index.ts';
import { Button, Label, NativeSelect } from '../ui/index.ts';
import { AwakeLine, PERIOD_TEXT } from './HomeClocks.tsx';
import { browserZone, clocksKey, useClocks, useNow, useTimezoneReport } from './queries.ts';
import { type Sleep } from '@between-pages/time';
import {
  awakeTogether,
  clockText,
  dayPeriod,
  dayText,
  localDay,
  minuteText,
  regionName,
  type DayPeriod,
} from './time.ts';

// The clocks page (two-clocks D2, D3): both local times, both sleep schedules (only the
// caller's editable) and today's hours when both are awake, each in its own local time.
// Without a current binding it shows nothing of anyone (D5).

const STEPS = Array.from({ length: 96 }, (_, i) => i * 15);

const PERIOD_ICON: Record<DayPeriod, LucideIcon> = {
  dawn: Sunrise,
  day: Sun,
  dusk: Sunset,
  night: Moon,
};

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
    <Label className="min-w-36 flex-1">
      {label}
      <NativeSelect value={value} onChange={(event) => set(Number(event.target.value))}>
        {STEPS.map((minute) => (
          <option key={minute} value={minute}>
            {minuteText(minute)}
          </option>
        ))}
      </NativeSelect>
    </Label>
  );
  return (
    <form
      className="flex flex-wrap items-end gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void save({ start, end });
      }}
    >
      {select('入睡', start, setStart)}
      {select('起床', end, setEnd)}
      <Button type="submit" variant="outline" disabled={saving || start === end}>
        保存作息
      </Button>
      {sleep && (
        <Button type="button" variant="ghost" disabled={saving} onClick={() => void save(null)}>
          清除
        </Button>
      )}
      {failed && (
        <p className="w-full rounded-xl bg-notice px-4 py-3 text-sm" role="alert">
          没有保存成功，请稍后再试
        </p>
      )}
    </form>
  );
}

const sleepText = (sleep: Sleep | null) =>
  sleep ? `${minuteText(sleep.start)}–${minuteText(sleep.end)}` : '还没设';

function Side({ who, now, zone }: { who: string; now: number; zone: string | null }) {
  if (!zone)
    return (
      <div>
        <p className="text-sm text-ink-soft">{who}</p>
        <p className="mt-3 text-ink-soft">TA 还没打开过新版本</p>
      </div>
    );
  const period = dayPeriod(now, zone);
  const Icon = PERIOD_ICON[period];
  return (
    <div>
      <p className="flex items-center gap-2 text-sm text-ink-soft">
        {who} · {PERIOD_TEXT[period]}
        <Icon aria-hidden="true" className="size-4" />
      </p>
      <p className="mt-2 font-serif text-5xl leading-tight tabular-nums">{clockText(now, zone)}</p>
      <p className="mt-1 text-sm text-ink-soft">
        {dayText(now, zone)} · {regionName(zone)}
      </p>
    </div>
  );
}

export function ClocksPage() {
  useTimezoneReport();
  const clocks = useClocks();
  const now = useNow();
  const partner = clocks.data?.partner;
  const zone = browserZone();
  const header = (
    <PageHeader title="两地时间" description="看看彼此的白天和夜晚，也给聊天留一点时间。" />
  );

  if (clocks.isPending) return <Page aria-busy="true" />;
  if (!partner)
    return (
      <Page>
        {header}
        <p className="text-ink-soft">绑定搭档后，这里会显示你们两边的时间。</p>
      </Page>
    );

  const me = { timezone: zone, sleep: clocks.data!.me.sleep };
  const day = localDay(now, zone);
  const together = awakeTogether(now, zone, [me, partner]);

  return (
    <Page>
      {header}
      <section className="grid gap-8 border-b border-line pb-8 sm:grid-cols-2">
        <Side who="你这边" now={now} zone={zone} />
        <Side who="TA 那边" now={now} zone={partner.timezone} />
      </section>
      <section className="border-b border-line py-8">
        <SectionTitle>今天你们都醒着的时间</SectionTitle>
        {together === null ? (
          <p className="text-sm text-ink-soft">两人都设好作息后，会显示今天你们都醒着的时间。</p>
        ) : (
          <>
            <p className="mb-6 text-sm text-ink-soft">
              {together.length === 0
                ? '今天没有两人都醒着的时间。'
                : '按你这边的日期与两人的作息推算。'}
            </p>
            <AwakeLine now={now} zone={zone} together={together} />
            {together.length > 0 && (
              <ul className="flex flex-wrap gap-x-10 gap-y-3">
                {together.map((free) => (
                  <li key={free.start}>
                    <span className="font-serif text-lg">
                      你 {clockText(free.start, zone, day.end)}–{clockText(free.end, zone, day.end)}
                    </span>
                    <span className="text-sm text-ink-soft">
                      {' '}
                      · TA {clockText(free.start, partner.timezone!)}–
                      {clockText(free.end, partner.timezone!)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>
      <section className="py-8">
        <SectionTitle>作息</SectionTitle>
        <p className="mb-4 text-sm text-ink-soft">你平时 {sleepText(me.sleep)} 睡</p>
        <SleepEditor key={JSON.stringify(me.sleep)} sleep={me.sleep} />
        <p className="mt-6 text-sm text-ink-soft">TA 平时 {sleepText(partner.sleep)} 睡</p>
      </section>
    </Page>
  );
}
