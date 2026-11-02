import { Link, useParams } from 'react-router';
import { BookSpread } from '../book/index.ts';
import { NextDay, useMinute } from './AnniversariesPage.tsx';
import { useAnniversary } from './queries.ts';
import { dateText, nameOf } from './text.ts';

// One anniversary's page (anniversaries D5): its date in every year so far, each linking to
// that day's page, where the diaries show under the sharing rules, and the gifts given for
// it that year. Nothing of a diary is copied here (invariant 7).

export function AnniversaryPage() {
  const { anniversaryId = '' } = useParams();
  const found = useAnniversary(anniversaryId);
  const now = useMinute();
  const view = found.data;
  if (found.isError)
    return (
      <main className="anniversaries">
        <BookSpread
          left={
            <>
              <p className="notice" role="alert">
                打不开这个纪念日，它可能已被删除
              </p>
              <Link to="/anniversaries">回到纪念日</Link>
            </>
          }
          right={null}
        />
      </main>
    );
  if (!view)
    return (
      <main className="anniversaries">
        <BookSpread left="正在打开…" right={null} />
      </main>
    );
  const a = view.anniversary;
  const giver = (id: string) => (id === view.me.id ? '我送的' : `${view.partner.displayName} 送的`);
  return (
    <main className="anniversaries">
      <BookSpread
        left={
          <>
            <Link className="book-back" to="/anniversaries">
              ← 纪念日
            </Link>
            <h1>{nameOf(a, view)}</h1>
            <p>
              {dateText(a)}
              {a.dayCount && ` · ${a.kind === 'together' ? '在一起' : ''}第 ${a.dayCount} 天`}
            </p>
            <NextDay a={a} now={now} />
            {a.note && <p className="anniversary-note">{a.note}</p>}
          </>
        }
        right={
          <>
            <h2>历年的这一天</h2>
            <ul className="records years">
              {view.years.map((y) => (
                <li key={y.year}>
                  <Link to={`/days/${y.date}`}>
                    {y.year} 年 {Number(y.date.slice(5, 7))} 月 {Number(y.date.slice(8))} 日
                  </Link>
                  {y.gifts.length > 0 && (
                    <ul className="year-gifts">
                      {y.gifts.map((g) => (
                        <li key={g.id}>
                          {g.name} · {giver(g.giverId)}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </>
        }
      />
    </main>
  );
}
