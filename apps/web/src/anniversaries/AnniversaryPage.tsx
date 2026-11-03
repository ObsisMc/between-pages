import { Link, useParams } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import { Page, PageHeader, SectionTitle } from '../shell/index.ts';
import { NextDay, useMinute } from './AnniversariesPage.tsx';
import { useAnniversary } from './queries.ts';
import { dateText, nameOf } from './text.ts';

// One anniversary's page (anniversaries D5): its date in every year so far, each linking to
// that day's page, where the diaries show under the sharing rules, and the gifts given for
// it that year. Nothing of a diary is copied here (invariant 7).

const back = (
  <Link
    to="/anniversaries"
    className="mb-6 inline-flex items-center gap-1 text-sm text-ink-soft hover:text-ink [&_svg]:size-4"
  >
    <ArrowLeft aria-hidden="true" />
    所有纪念日
  </Link>
);

export function AnniversaryPage() {
  const { anniversaryId = '' } = useParams();
  const found = useAnniversary(anniversaryId);
  const now = useMinute();
  const view = found.data;
  if (found.isError)
    return (
      <Page>
        {back}
        <p className="rounded-xl bg-notice px-4 py-3 text-sm" role="alert">
          打不开这个纪念日，它可能已被删除
        </p>
      </Page>
    );
  if (!view) return <Page className="text-ink-soft">正在打开…</Page>;
  const a = view.anniversary;
  const giver = (id: string) => (id === view.me.id ? '我送的' : `${view.partner.displayName} 送的`);
  return (
    <Page>
      <PageHeader
        above={
          <>
            <div>{back}</div>
            <p className="mb-3 text-xs tracking-widest text-ink-soft">
              {dateText(a)}
              {a.dayCount && ` · ${a.kind === 'together' ? '在一起' : ''}第 ${a.dayCount} 天`}
            </p>
          </>
        }
        title={nameOf(a, view)}
        description={
          <>
            <NextDay a={a} now={now} />
            {a.note && <p className="mt-1">{a.note}</p>}
          </>
        }
      />
      <section className="max-w-2xl">
        <SectionTitle>历年的这一天</SectionTitle>
        <ul>
          {view.years.map((y) => (
            <li key={y.year} className="flex gap-5 border-b border-line py-5">
              <span
                aria-hidden="true"
                className="w-14 shrink-0 font-serif text-2xl text-ink-soft tabular-nums"
              >
                {y.year}
              </span>
              <div className="min-w-0">
                <Link to={`/days/${y.date}`} className="underline-offset-4 hover:underline">
                  {y.year} 年 {Number(y.date.slice(5, 7))} 月 {Number(y.date.slice(8))} 日
                </Link>
                {y.gifts.length > 0 && (
                  <ul className="mt-1 text-sm text-ink-soft">
                    {y.gifts.map((g) => (
                      <li key={g.id}>
                        {g.name} · {giver(g.giverId)}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>
    </Page>
  );
}
