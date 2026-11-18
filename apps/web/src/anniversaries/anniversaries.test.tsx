import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderAt, stubApi } from '../../test/render.tsx';
import { AnniversariesPage } from './AnniversariesPage.tsx';
import { AnniversaryPage } from './AnniversaryPage.tsx';

// The anniversaries pages (anniversaries ADR, partner-local-dates D1, D2).

const ME = { id: '6f1c1d0e-0000-4000-8000-000000000001', displayName: 'alice' };
const PARTNER = { id: '6f1c1d0e-0000-4000-8000-000000000002', displayName: 'bo' };
const AT = '2026-10-30T08:00:00.000Z';
const ID = '0d0d0d0d-0000-4000-8000-000000000001';
const ZONE = encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone);
const LIST = `GET /api/anniversaries?timezone=${ZONE}`;

const anniversary = (over: object = {}) => ({
  id: ID,
  authorId: ME.id,
  kind: 'together',
  birthdayOf: null,
  name: null,
  note: '在车站',
  year: 2024,
  month: 1,
  day: 1,
  dateSet: null,
  showCount: true,
  countSet: { by: PARTNER.id, at: AT },
  reminder: 7,
  basis: 'partner',
  dayCount: 1034,
  next: {
    date: '2027-01-01',
    startsAt: '2026-12-31T16:00:00.000Z',
    endsAt: '2027-01-01T16:00:00.000Z',
    type: 'yearly',
    years: 3,
    count: null,
    daysLeft: 63,
  },
  due: false,
  revision: 1,
  createdAt: AT,
  updatedAt: AT,
  unread: null,
  mark: 0,
  ...over,
});
const view = (over: object = {}) => ({
  me: ME,
  partner: PARTNER,
  readOnly: false,
  anniversaries: [anniversary()],
  home: null,
  notes: [],
  ...over,
});
const routes = [
  { path: '/anniversaries', element: <AnniversariesPage /> },
  { path: '/anniversaries/:anniversaryId', element: <AnniversaryPage /> },
];

beforeEach(() =>
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      disconnect() {}
    },
  ),
);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AnniversariesPage', () => {
  it('[adr:anniversaries#3] [adr:partner-local-dates#1] shows the day count and the next day in the partner’s date', async () => {
    stubApi({ [LIST]: () => Response.json(view()) });
    renderAt('/anniversaries', routes);
    // The together day leads the page, its count set large.
    expect(
      await screen.findByText(
        (_, el) => el?.tagName === 'P' && el.textContent === '在一起第 1034 天',
      ),
    ).toBeDefined();
    expect(screen.getByText(/2027 \/ 01 \/ 01/).textContent).toBe(
      '2027 / 01 / 01 · 3 周年 · 还有 63 天 · 按 TA 那边的日期',
    );
    expect(screen.getByText(/打开了计数/).textContent).toContain('bo 打开了计数');
  });

  it('[adr:partner-local-dates#2] says when the partner’s zone is unknown', async () => {
    stubApi({
      [LIST]: () => Response.json(view({ anniversaries: [anniversary({ basis: 'unknown' })] })),
    });
    renderAt('/anniversaries', routes);
    expect(await screen.findByText(/TA 那边的时区未知，按你这边的日期/)).toBeDefined();
  });

  it('[adr:anniversaries#4] sets only the caller’s own reminder, even after unbinding, while every shared control is gone', async () => {
    const saved = vi.fn((init: RequestInit | undefined) =>
      Response.json({ anniversary: anniversary(JSON.parse(String(init?.body)) as object) }),
    );
    stubApi({
      [LIST]: () => Response.json(view({ readOnly: true })),
      [`PUT /api/anniversaries/${ID}/reminder?timezone=${ZONE}`]: saved,
      'GET /api/space/unread': () =>
        Response.json({ features: { wishes: 0, anniversaries: 0, sharedPages: 0 } }),
    });
    renderAt('/anniversaries', routes);
    expect(await screen.findByText('已解绑，记录只读')).toBeDefined();
    for (const name of ['记下一天', '修改', '编辑', '删除'])
      expect(screen.queryByRole('button', { name })).toBeNull();
    expect(screen.queryByLabelText('日期')).toBeNull();
    fireEvent.change(screen.getByLabelText('提醒我'), { target: { value: 'null' } });
    await waitFor(() => expect(saved).toHaveBeenCalled());
    expect(JSON.parse(String(saved.mock.calls[0]![0]!.body))).toEqual({ days: null });
  });

  it('says a deleted anniversary stays in the partner’s Google Drive', async () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    stubApi({
      [LIST]: () => Response.json(view()),
      'GET /api/space/unread': () =>
        Response.json({ features: { wishes: 0, anniversaries: 0, sharedPages: 0 } }),
    });
    renderAt('/anniversaries', routes);
    fireEvent.click(await screen.findByRole('button', { name: '修改' }));
    fireEvent.click(await screen.findByRole('button', { name: '删除' }));
    expect(confirm).toHaveBeenCalledWith(
      '删除"在一起的日子"？已经备份到对方 Google Drive 的内容不会因此删除。',
    );
  });

  it('records a birthday without a year, and explains a second together day', async () => {
    const bodies: unknown[] = [];
    stubApi({
      [LIST]: () => Response.json(view({ anniversaries: [] })),
      [`POST /api/anniversaries?timezone=${ZONE}`]: (init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return bodies.length === 1
          ? Response.json({
              anniversary: anniversary({ kind: 'birthday', birthdayOf: PARTNER.id }),
            })
          : Response.json({ error: { code: 'RECORD_EXISTS', message: 'x' } }, { status: 409 });
      },
      'GET /api/space/unread': () =>
        Response.json({ features: { wishes: 0, anniversaries: 0, sharedPages: 0 } }),
    });
    renderAt('/anniversaries', routes);
    fireEvent.click(await screen.findByRole('button', { name: '记下一天' }));
    fireEvent.change(screen.getByLabelText('日期'), { target: { value: '2001-02-28' } });
    fireEvent.click(screen.getByLabelText('不记年份'));
    fireEvent.click(screen.getByRole('button', { name: '记下' }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    // Recorded: the dialog closes.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(bodies[0]).toMatchObject({
      kind: 'birthday',
      birthdayOf: PARTNER.id,
      name: null,
      year: null,
      month: 2,
      day: 28,
    });
    fireEvent.click(screen.getByRole('button', { name: '记下一天' }));
    fireEvent.change(screen.getByLabelText('种类'), { target: { value: 'together' } });
    fireEvent.click(screen.getByRole('button', { name: '记下' }));
    expect((await screen.findByRole('alert')).textContent).toBe('已经有一个了，打开那一个修改');
    // A refusal keeps the dialog open with what was entered.
    expect(screen.getByRole('dialog')).toBeDefined();
  });

  it('[adr:digital-paper-interface#2] keeps what was typed when the dialog is closed unsent', async () => {
    stubApi({ [LIST]: () => Response.json(view({ anniversaries: [] })) });
    renderAt('/anniversaries', routes);
    fireEvent.click(await screen.findByRole('button', { name: '记下一天' }));
    fireEvent.change(screen.getByLabelText('种类'), { target: { value: 'other' } });
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '第一次见面' } });
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: '记下一天' }));
    expect((screen.getByLabelText('名称') as HTMLInputElement).value).toBe('第一次见面');
  });

  it('folds the shared changes under "修改", the reminder beside it', async () => {
    stubApi({ [LIST]: () => Response.json(view()) });
    renderAt('/anniversaries', routes);
    const fold = await screen.findByRole('button', { name: '修改' });
    expect(screen.getByLabelText('提醒我')).toBeDefined();
    expect(screen.queryByLabelText('日期')).toBeNull();
    fireEvent.click(fold);
    expect(fold.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByLabelText('日期')).toBeDefined();
    expect(screen.getByLabelText('显示第 N 天')).toBeDefined();
    expect(screen.getByRole('button', { name: '编辑' })).toBeDefined();
  });
});

describe('AnniversaryPage', () => {
  it('[adr:anniversaries#7] links each year to its day page and lists the gifts given for it', async () => {
    stubApi({
      [`GET /api/anniversaries/${ID}?timezone=${ZONE}`]: () =>
        Response.json({
          me: ME,
          partner: PARTNER,
          readOnly: false,
          anniversary: anniversary(),
          years: [
            { year: 2026, date: '2026-01-01', gifts: [] },
            {
              year: 2025,
              date: '2025-01-01',
              gifts: [
                {
                  id: '0c0c0c0c-0000-4000-8000-000000000001',
                  name: '花',
                  giverId: PARTNER.id,
                  date: '2025-01-01',
                },
              ],
            },
          ],
        }),
    });
    renderAt(`/anniversaries/${ID}`, routes);
    const year = await screen.findByRole('link', { name: '2025 年 1 月 1 日' });
    expect(year.getAttribute('href')).toBe('/days/2025-01-01');
    expect(screen.getByText('花 · bo 送的')).toBeDefined();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('在一起的日子');
  });
});
