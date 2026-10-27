import { useState } from 'react';
import type { DateSelection } from '@between-pages/contracts';
import { isShared } from './range.ts';

const pad = (n: number) => String(n).padStart(2, '0');
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

/**
 * One calendar month marking the days a selection shares. Calendar days only: they are
 * diary dates, never instants, so no time zone is applied (D3).
 */
export function MonthView({ selection }: { selection: DateSelection }) {
  const today = new Date();
  const [month, setMonth] = useState({ year: today.getFullYear(), month: today.getMonth() });
  const first = new Date(Date.UTC(month.year, month.month, 1));
  const days = new Date(Date.UTC(month.year, month.month + 1, 0)).getUTCDate();
  const blanks = first.getUTCDay();
  const shift = (by: number) =>
    setMonth(({ year, month: m }) => {
      const d = new Date(Date.UTC(year, m + by, 1));
      return { year: d.getUTCFullYear(), month: d.getUTCMonth() };
    });

  return (
    <div className="month-view">
      <div className="month-nav">
        <button type="button" onClick={() => shift(-1)} aria-label="上个月">
          ‹
        </button>
        <span>
          {month.year} 年 {month.month + 1} 月
        </span>
        <button type="button" onClick={() => shift(1)} aria-label="下个月">
          ›
        </button>
      </div>
      <div className="month-grid">
        {WEEKDAYS.map((w) => (
          <span key={w} className="month-weekday">
            {w}
          </span>
        ))}
        {Array.from({ length: blanks }, (_, i) => (
          <span key={`b${i}`} />
        ))}
        {Array.from({ length: days }, (_, i) => {
          const day = `${month.year}-${pad(month.month + 1)}-${pad(i + 1)}`;
          const shared = isShared(selection, day);
          return (
            <span
              key={day}
              className={shared ? 'month-day shared' : 'month-day'}
              aria-label={`${month.month + 1} 月 ${i + 1} 日${shared ? '共享' : '不共享'}`}
            >
              {i + 1}
            </span>
          );
        })}
      </div>
    </div>
  );
}
