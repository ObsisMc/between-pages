import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderAt, signedIn, stubApi } from '../../test/render.tsx';
import { ClockStrip } from './ClockStrip.tsx';
import { ClocksPage } from './ClocksPage.tsx';

// The viewer is in Shanghai; 2026-11-10 18:00 UTC is 2:00 in Shanghai and 3:00 in Tokyo.
const NOW = Date.UTC(2026, 10, 10, 18);
let zone: string | undefined;
beforeAll(() => {
  zone = process.env.TZ;
  process.env.TZ = 'Asia/Shanghai';
});
afterAll(() => {
  process.env.TZ = zone;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const at = (now: number) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
};

const PARTNER = { id: '6f1c1d0e-0000-4000-8000-000000000002', displayName: 'bo' };
const clocks = (me: object, partner: object | null) => () =>
  Response.json({
    me: { timezone: 'Asia/Shanghai', sleep: null, ...me },
    partner: partner && { user: PARTNER, timezone: null, sleep: null, ...partner },
  });

const routes = [
  { path: '/', element: <ClockStrip /> },
  { path: '/clocks', element: <ClocksPage /> },
];

describe('ClockStrip', () => {
  it('[adr:two-clocks#6] shows nothing without a current binding', async () => {
    const fetchMock = stubApi({ 'GET /api/clocks': clocks({}, null) });
    renderAt('/', routes);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByText(/TA 那边/)).toBeNull();
  });

  it("shows the partner's local time, its region and that they are probably asleep", async () => {
    at(NOW);
    stubApi({
      'GET /api/clocks': clocks({}, { timezone: 'Asia/Tokyo', sleep: { start: 0, end: 480 } }),
    });
    renderAt('/', routes);
    const strip = await screen.findByText(/TA 那边/);
    expect(strip.textContent).toBe('TA 那边 3:00 · 夜里 · 日本标准时间 · 大概在睡 · 两地时间');
    expect(strip.className).toContain('period-night');
  });

  it('[adr:two-clocks#2] reports a browser zone that differs from the stored one', async () => {
    const fetchMock = stubApi({
      'GET /api/clocks': clocks({ timezone: 'Asia/Tokyo' }, null),
      'PUT /api/me/timezone': () => Response.json({ timezone: 'Asia/Shanghai', sleep: null }),
    });
    renderAt('/', routes);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/me/timezone',
        expect.objectContaining({ body: JSON.stringify({ timezone: 'Asia/Shanghai' }) }),
      ),
    );
  });
});

describe('ClocksPage', () => {
  it('[adr:two-clocks#6] shows nothing of anyone without a current binding', async () => {
    stubApi({ 'GET /api/me': signedIn(), 'GET /api/clocks': clocks({}, null) });
    renderAt('/clocks', routes);
    expect(await screen.findByText('绑定搭档后，这里会显示你们两边的时间。')).toBeDefined();
    expect(screen.queryByText(/作息/)).toBeNull();
  });

  it("[adr:two-clocks#4] lists today's shared awake hours in both local times", async () => {
    at(NOW);
    stubApi({
      'GET /api/clocks': clocks(
        { sleep: { start: 0, end: 480 } },
        { timezone: 'Asia/Tokyo', sleep: { start: 1380, end: 420 } },
      ),
    });
    renderAt('/clocks', routes);
    // Shanghai sleeps 0:00–8:00; Tokyo 23:00–7:00 is 22:00–6:00 in Shanghai.
    expect((await screen.findByRole('list')).textContent).toBe('你 8:00–22:00 · TA 9:00–23:00');
  });

  it('asks for both schedules before showing shared hours', async () => {
    at(NOW);
    stubApi({
      'GET /api/clocks': clocks({ sleep: { start: 0, end: 480 } }, { timezone: 'Asia/Tokyo' }),
    });
    renderAt('/clocks', routes);
    expect(await screen.findByText('两人都设好作息后，会显示今天你们都醒着的时间。')).toBeDefined();
    expect(screen.getByText('TA 平时 还没设 睡')).toBeDefined();
  });

  it('[adr:two-clocks#3] saves a sleep schedule that crosses midnight', async () => {
    const fetchMock = stubApi({
      'GET /api/clocks': clocks({}, { timezone: 'Asia/Tokyo' }),
      'PUT /api/me/sleep': (init) =>
        Response.json({ timezone: 'Asia/Shanghai', ...JSON.parse(String(init?.body)) }),
    });
    renderAt('/clocks', routes);
    fireEvent.change(await screen.findByLabelText('入睡'), { target: { value: '1410' } });
    fireEvent.change(screen.getByLabelText('起床'), { target: { value: '450' } });
    fireEvent.click(screen.getByText('保存作息'));
    expect(await screen.findByText('你平时 23:30–7:30 睡')).toBeDefined();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/me/sleep',
      expect.objectContaining({ body: JSON.stringify({ sleep: { start: 1410, end: 450 } }) }),
    );
  });
});
