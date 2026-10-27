// Relationship answers as the API returns them, for component tests.

export const ME = '6f1c1d0e-0000-4000-8000-000000000001';
export const PARTNER = '6f1c1d0e-0000-4000-8000-000000000002';
export const SPACE = '2b0c1a9e-1111-4a2b-8c3d-4e5f6a7b8c9d';
export const PERIOD = '3c1d2b0f-2222-4b3c-9d4e-5f6a7b8c9d0e';
export const OLD_PERIOD = '4d2e3c1a-3333-4c4d-8e5f-6a7b8c9d0e1f';
export const INVITE = '5e3f4d2b-4444-4d5e-9f6a-7b8c9d0e1f2a';
export const TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';

export const space = (state: 'active' | 'archived' = 'active') => ({
  id: SPACE,
  createdAt: '2026-10-01T08:00:00.000Z',
  state,
  participants: [
    { user: { id: ME, displayName: 'alice' }, authorSlot: 1 },
    { user: { id: PARTNER, displayName: 'bob' }, authorSlot: 2 },
  ],
});

export const periods = (open: boolean) => [
  { id: OLD_PERIOD, startedAt: '2026-09-01T08:00:00.000Z', endedAt: '2026-09-10T08:00:00.000Z' },
  {
    id: PERIOD,
    startedAt: '2026-10-01T08:00:00.000Z',
    endedAt: open ? null : '2026-10-20T08:00:00.000Z',
  },
];

export const errorBody = (code: string, status: number) => () =>
  Response.json({ error: { code, message: 'no' } }, { status });
