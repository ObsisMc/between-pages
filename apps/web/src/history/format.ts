import type { ResponseOf } from '@between-pages/contracts';

export type HistoryPointView = ResponseOf<'history'>['points'][number];

// Times are UTC instants from the server, shown in the viewer's own time zone (spec §8.2).
const day = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' });
const dayText = new Intl.DateTimeFormat(undefined, { dateStyle: 'long' });
const timeText = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' });
const fullText = new Intl.DateTimeFormat(undefined, { dateStyle: 'long', timeStyle: 'short' });

/** The local calendar day of an instant, for grouping. */
export const dayOf = (at: string) => day.format(new Date(at));
export const dayLabel = (at: string) => dayText.format(new Date(at));
export const timeLabel = (at: string) => timeText.format(new Date(at));
export const fullLabel = (at: string) => fullText.format(new Date(at));

/** A countdown in whole seconds, rounded up: "1 分 40 秒", "2 分钟", "40 秒". */
export function countdownLabel(ms: number): string {
  const seconds = Math.ceil(ms / 1000);
  const [minutes, rest] = [Math.floor(seconds / 60), seconds % 60];
  if (minutes === 0) return `${rest} 秒`;
  return rest === 0 ? `${minutes} 分钟` : `${minutes} 分 ${rest} 秒`;
}
