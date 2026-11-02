import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderAt, stubApi } from '../../test/render.tsx';
import { WishesPage } from './WishesPage.tsx';

// The wishes page (wishes-and-gifts ADR) with the space-common parts it uses (space-records D8).

const ME = { id: '6f1c1d0e-0000-4000-8000-000000000001', displayName: 'alice' };
const PARTNER = { id: '6f1c1d0e-0000-4000-8000-000000000002', displayName: 'bo' };
const AT = '2026-10-30T08:00:00.000Z';
const wish = (over: object = {}) => ({
  id: '0b0b0b0b-0000-4000-8000-000000000001',
  authorId: PARTNER.id,
  name: '灰色围巾',
  link: 'https://shop.example/scarf',
  note: '要羊毛的',
  want: 4,
  preview: { state: 'ready', title: '羊毛围巾', site: '小店', image: 'https://img.example/s.jpg' },
  revision: 1,
  createdAt: AT,
  updatedAt: AT,
  preparingGiftId: null,
  unread: null,
  mark: 0,
  ...over,
});
const gift = (over: object = {}) => ({
  id: '0c0c0c0c-0000-4000-8000-000000000001',
  authorId: PARTNER.id,
  giverId: PARTNER.id,
  receiverId: ME.id,
  wishId: null,
  name: '花',
  link: null,
  preview: null,
  status: 'revealed',
  revealed: { by: PARTNER.id, at: AT },
  date: '2026-10-30',
  dateSet: null,
  occasion: null,
  anniversary: null,
  occasionSet: null,
  card: null,
  revision: 1,
  createdAt: AT,
  unread: null,
  mark: 0,
  ...over,
});
const view = (over: object = {}) => ({
  me: ME,
  partner: PARTNER,
  readOnly: false,
  mine: [],
  theirs: [],
  preparing: [],
  wall: [],
  notes: [],
  ...over,
});
const routes = [{ path: '/wishes', element: <WishesPage /> }];
const ZONE = encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone);
const anniversariesPath = `GET /api/anniversaries?timezone=${ZONE}`;
/** The space's anniversaries, for the occasion choice. */
const anniversaries = (list: object[] = []) => ({
  [anniversariesPath]: () =>
    Response.json({
      me: ME,
      partner: PARTNER,
      readOnly: false,
      anniversaries: list,
      home: null,
      notes: [],
    }),
});

/** IntersectionObserver for jsdom: every observed element is in view. */
class SeeEverything {
  private readonly callback: IntersectionObserverCallback;
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
  }
  observe(target: Element) {
    this.callback(
      [{ isIntersecting: true, target } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
  disconnect() {}
}
beforeEach(() => vi.stubGlobal('IntersectionObserver', SeeEverything));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('WishesPage', () => {
  it('[adr:wishes-and-gifts#8] loads the preview image without a referrer, falling back to the site name', async () => {
    stubApi({ 'GET /api/wishes': () => Response.json(view({ theirs: [wish()] })) });
    renderAt('/wishes', routes);
    const image = (await screen.findByText('羊毛围巾')).closest('a')!.querySelector('img')!;
    expect(image.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(image.getAttribute('src')).toBe('https://img.example/s.jpg');
    fireEvent.error(image);
    await waitFor(() =>
      expect(screen.getByText('羊毛围巾').closest('a')!.querySelector('img')).toBeNull(),
    );
    expect(screen.getByText('小店')).toBeDefined();
    expect(screen.getByRole('img', { name: '想要程度 4/5' })).toBeDefined();
  });

  it("marks the caller's own preparation on the partner's wish, and offers to start one otherwise", async () => {
    const prepared = vi.fn(() =>
      Response.json({ gift: gift({ status: 'preparing', revealed: null, date: null }) }),
    );
    stubApi({
      'GET /api/wishes': () =>
        Response.json(
          view({
            theirs: [
              wish(),
              wish({
                id: '0b0b0b0b-0000-4000-8000-000000000002',
                name: '书',
                preparingGiftId: gift().id,
              }),
            ],
          }),
        ),
      'POST /api/gifts': prepared,
    });
    renderAt('/wishes', routes);
    expect((await screen.findByText(/你在准备/)).textContent).toBe('你在准备 · 写卡片、揭晓');
    fireEvent.click(screen.getByRole('button', { name: '我在准备' }));
    await waitFor(() => expect(prepared).toHaveBeenCalled());
  });

  it('[adr:space-records#9] reports a new record once it has been on screen for a second, at its mark', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const reported = vi.fn((init: RequestInit | undefined) => {
      void init;
      return Response.json({ recorded: true });
    });
    stubApi({
      'GET /api/wishes': () => Response.json(view({ theirs: [wish({ unread: 'new', mark: 1 })] })),
      'POST /api/space/seen': reported,
      'GET /api/space/unread': () => Response.json({ features: { wishes: 0 } }),
    });
    renderAt('/wishes', routes);
    await vi.waitFor(() => expect(screen.getByText('新')).toBeDefined());
    expect(screen.getByText(/有 1 处新内容/).textContent).toBe('有 1 处新内容 · 跳到第一处');
    await act(() => vi.advanceTimersByTimeAsync(900));
    expect(reported).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(200));
    expect(reported).toHaveBeenCalledTimes(1);
    expect(JSON.parse(reported.mock.calls[0]![0]!.body as string)).toEqual({
      records: [{ type: 'wish', id: wish().id, mark: 1 }],
    });
  });

  it('[adr:space-records#7] shows a note for a deleted record the caller had acted on', async () => {
    stubApi({
      'GET /api/wishes': () =>
        Response.json(
          view({
            notes: [
              {
                type: 'wish',
                id: wish().id,
                name: '灰色围巾',
                deleted: { by: PARTNER.id, at: AT },
                acted: 'prepared',
                unread: null,
                mark: 1,
              },
            ],
          }),
        ),
    });
    renderAt('/wishes', routes);
    expect((await screen.findByText(/删了/)).textContent).toContain(
      'bo 删了"灰色围巾"（你在准备）',
    );
  });

  it('[adr:wishes-and-gifts#9] is read-only after unbinding: a notice and no writing controls', async () => {
    stubApi({
      'GET /api/wishes': () =>
        Response.json(view({ readOnly: true, mine: [wish({ authorId: ME.id })], wall: [gift()] })),
      ...anniversaries(),
    });
    renderAt('/wishes', routes);
    expect(await screen.findByText('已解绑，记录只读')).toBeDefined();
    for (const name of ['许个愿', '收到了', '编辑', '删除', '悄悄准备'])
      expect(screen.queryByRole('button', { name })).toBeNull();
    expect(screen.queryByLabelText('日期')).toBeNull();
  });

  it('says why a write was refused and keeps the request ID for sending again', async () => {
    const bodies: string[] = [];
    let attempts = 0;
    stubApi({
      'GET /api/wishes': () => Response.json(view({ mine: [wish({ authorId: ME.id })] })),
      'POST /api/wishes/0b0b0b0b-0000-4000-8000-000000000001/received': (init) => {
        bodies.push(init!.body as string);
        attempts++;
        return attempts === 1
          ? Response.json({ error: { code: 'SPACE_READ_ONLY', message: 'x' } }, { status: 409 })
          : Response.json({ giftId: gift().id });
      },
      'GET /api/space/unread': () => Response.json({ features: { wishes: 0 } }),
    });
    renderAt('/wishes', routes);
    fireEvent.click(await screen.findByRole('button', { name: '收到了' }));
    expect((await screen.findByRole('alert')).textContent).toBe('已解绑，记录只读');
    fireEvent.click(screen.getByRole('button', { name: '收到了' }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]).toBe(bodies[0]);
  });

  it('[adr:anniversaries#6] filters the gift wall by who gave it and by occasion, a deleted anniversary by the name the gift kept', async () => {
    const MET = '0d0d0d0d-0000-4000-8000-000000000001';
    const GONE = '0d0d0d0d-0000-4000-8000-000000000002';
    stubApi({
      'GET /api/wishes': () =>
        Response.json(
          view({
            wall: [
              gift(),
              gift({
                id: '0c0c0c0c-0000-4000-8000-000000000002',
                name: '杯子',
                giverId: ME.id,
                receiverId: PARTNER.id,
                occasion: 'holiday',
              }),
              gift({
                id: '0c0c0c0c-0000-4000-8000-000000000003',
                name: '书',
                anniversary: { id: MET, name: '旧名字' },
              }),
              gift({
                id: '0c0c0c0c-0000-4000-8000-000000000004',
                name: '信',
                anniversary: { id: GONE, name: '认识的日子' },
              }),
            ],
          }),
        ),
      ...anniversaries([
        {
          id: MET,
          authorId: ME.id,
          kind: 'other',
          birthdayOf: null,
          name: '第一次见面',
          note: null,
          year: 2024,
          month: 6,
          day: 1,
          dateSet: null,
          showCount: false,
          countSet: null,
          reminder: 7,
          basis: 'partner',
          dayCount: null,
          next: {
            date: '2027-06-01',
            startsAt: '2027-05-31T16:00:00.000Z',
            endsAt: '2027-06-01T16:00:00.000Z',
            type: 'yearly',
            years: 3,
            count: null,
            daysLeft: 214,
          },
          due: false,
          revision: 1,
          createdAt: AT,
          updatedAt: AT,
          unread: null,
          mark: 0,
        },
      ]),
    });
    renderAt('/wishes', routes);
    expect(await screen.findByText('杯子')).toBeDefined();
    // A linked anniversary shows its name now and links to it; a deleted one, the kept name.
    const linked = await screen.findByRole('link', { name: '第一次见面' });
    expect(linked.getAttribute('href')).toBe(`/anniversaries/${MET}`);
    expect(screen.getByText(/认识的日子/, { selector: '.gift-meta' })).toBeDefined();
    fireEvent.change(screen.getByLabelText('谁送的'), { target: { value: 'partner' } });
    expect(screen.queryByText('杯子')).toBeNull();
    expect(screen.getByText('花')).toBeDefined();
    fireEvent.change(screen.getByLabelText('谁送的'), { target: { value: 'all' } });
    const occasion = screen.getByLabelText('场合', { selector: '.filters select' });
    fireEvent.change(occasion, { target: { value: 'holiday' } });
    expect(screen.queryByText('花')).toBeNull();
    expect(screen.getByText('杯子')).toBeDefined();
    fireEvent.change(occasion, { target: { value: `a:${GONE}` } });
    expect(screen.getByText('信')).toBeDefined();
    expect(screen.queryByText('书')).toBeNull();
    fireEvent.change(occasion, { target: { value: 'none' } });
    expect(screen.getByText('花')).toBeDefined();
    expect(screen.queryByText('信')).toBeNull();
  });
});
