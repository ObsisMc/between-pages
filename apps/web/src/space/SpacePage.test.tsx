import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderAt, signedIn, stubApi } from '../../test/render.tsx';
import { PERIOD, SPACE, errorBody, periods, space } from '../../test/relationship.ts';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const OCTOBER = { include: [{ from: '2026-10-01', to: '2026-10-31' }], exclude: [] };
const mine = (revision: number, confirmedPeriodId: string | null) => () =>
  Response.json({ selection: OCTOBER, revision, confirmedPeriodId });

describe('SpacePage', () => {
  it('shows the partner, the binding history and the own range with whether it is shared now', async () => {
    stubApi({
      'GET /api/me': signedIn('alice'),
      [`GET /api/spaces/${SPACE}`]: () => Response.json({ space: space(), periods: periods(true) }),
      [`GET /api/spaces/${SPACE}/my-sharing`]: mine(1, PERIOD),
    });
    renderAt(`/spaces/${SPACE}`);

    expect(await screen.findByText('与 bob 的空间')).toBeDefined();
    expect(screen.getByText('每人只共享自己确认过的日期')).toBeDefined();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(
      screen.getByText(/共享：2026-10-01 至 2026-10-31（已为本次绑定确认，正在共享）/),
    ).toBeDefined();
  });

  it('[adr:spaces-and-invitations#8] shows the change before saving and sends the revision it was based on', async () => {
    let revision = 1;
    const saved = vi.fn((init: RequestInit | undefined) => {
      void init;
      revision = 2;
      return Response.json({ revision: 2, changeId: PERIOD });
    });
    stubApi({
      'GET /api/me': signedIn('alice'),
      [`GET /api/spaces/${SPACE}`]: () => Response.json({ space: space(), periods: periods(true) }),
      [`GET /api/spaces/${SPACE}/my-sharing`]: () => mine(revision, PERIOD)(),
      [`PUT /api/spaces/${SPACE}/my-sharing`]: saved,
    });
    renderAt(`/spaces/${SPACE}`);

    fireEvent.click(await screen.findByLabelText('全部历史与以后的日期'));
    fireEvent.click(screen.getByText('保存范围'));
    expect(screen.getByText('保存后：共享：全部历史与以后')).toBeDefined();
    expect(saved).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('确认保存'));

    await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
    expect(JSON.parse(saved.mock.calls[0]![0]!.body as string)).toMatchObject({
      expectedPeriodId: PERIOD,
      expectedRevision: 1,
      selection: { include: [{ from: null, to: null }], exclude: [] },
    });
  });

  it('[adr:diary-collaboration-kernel#17] says which dates open and which stop before confirming', async () => {
    stubApi({
      'GET /api/me': signedIn('alice'),
      [`GET /api/spaces/${SPACE}`]: () => Response.json({ space: space(), periods: periods(true) }),
      [`GET /api/spaces/${SPACE}/my-sharing`]: mine(1, PERIOD),
    });
    renderAt(`/spaces/${SPACE}`);

    fireEvent.click(await screen.findByLabelText('全部历史与以后的日期'));
    fireEvent.click(screen.getByText('保存范围'));

    expect(screen.getByText(/^将开放：2026-09-30 及以前；2026-11-01 起持续。/)).toBeDefined();
    expect(screen.getByText(/撤销记录从开放时重新开始/)).toBeDefined();
    expect(screen.queryByText(/将停止更新/)).toBeNull();
  });

  it('[adr:diary-collaboration-kernel#17] confirming for this binding for the first time opens every chosen date', async () => {
    stubApi({
      'GET /api/me': signedIn('alice'),
      [`GET /api/spaces/${SPACE}`]: () => Response.json({ space: space(), periods: periods(true) }),
      // Confirmed for an earlier binding only: nothing is shared now.
      [`GET /api/spaces/${SPACE}/my-sharing`]: mine(1, null),
    });
    renderAt(`/spaces/${SPACE}`);

    expect(await screen.findByText(/尚未为本次绑定确认，日记没有共享/)).toBeDefined();
    fireEvent.click(screen.getByText('保存范围'));
    expect(screen.getByText(/^将开放：2026-10-01 至 2026-10-31。/)).toBeDefined();
  });

  it('[adr:diary-collaboration-kernel#17] names the dates that could not open and saves nothing', async () => {
    stubApi({
      'GET /api/me': signedIn('alice'),
      [`GET /api/spaces/${SPACE}`]: () => Response.json({ space: space(), periods: periods(true) }),
      [`GET /api/spaces/${SPACE}/my-sharing`]: mine(1, PERIOD),
      [`PUT /api/spaces/${SPACE}/my-sharing`]: () =>
        Response.json(
          {
            error: {
              code: 'SHARE_OPEN_FAILED',
              message: 'x',
              dates: ['2026-09-15', '2026-09-16'],
            },
          },
          { status: 409 },
        ),
    });
    renderAt(`/spaces/${SPACE}`);
    fireEvent.click(await screen.findByLabelText('全部历史与以后的日期'));
    fireEvent.click(screen.getByText('保存范围'));
    fireEvent.click(screen.getByText('确认保存'));

    expect((await screen.findByRole('alert')).textContent).toContain(
      '这些日期的日记暂时无法共享，这次设置没有保存：2026-09-15、2026-09-16',
    );
  });

  it('asks to reload when the range changed elsewhere', async () => {
    stubApi({
      'GET /api/me': signedIn('alice'),
      [`GET /api/spaces/${SPACE}`]: () => Response.json({ space: space(), periods: periods(true) }),
      [`GET /api/spaces/${SPACE}/my-sharing`]: mine(1, PERIOD),
      [`PUT /api/spaces/${SPACE}/my-sharing`]: errorBody('POLICY_CONFLICT', 409),
    });
    renderAt(`/spaces/${SPACE}`);
    fireEvent.click(await screen.findByText('保存范围'));
    fireEvent.click(screen.getByText('确认保存'));

    expect((await screen.findByRole('alert')).textContent).toContain(
      '共享范围已在别处修改，请重新载入后再改',
    );
  });

  it('[adr:spaces-and-invitations#7] unbinds only after a second confirmation, naming the period it ends', async () => {
    let open = true;
    const unbound = vi.fn((init: RequestInit | undefined) => {
      void init;
      open = false;
      return Response.json({ spaceId: SPACE, closedPeriodId: PERIOD });
    });
    stubApi({
      'GET /api/me': signedIn('alice'),
      [`GET /api/spaces/${SPACE}`]: () =>
        Response.json({ space: space(open ? 'active' : 'archived'), periods: periods(open) }),
      [`GET /api/spaces/${SPACE}/my-sharing`]: mine(1, PERIOD),
      'GET /api/binding': () => Response.json({ binding: null, invitation: null }),
      'GET /api/spaces': () => Response.json({ spaces: [] }),
      [`POST /api/spaces/${SPACE}/unbind`]: unbound,
    });
    renderAt(`/spaces/${SPACE}`);

    fireEvent.click(await screen.findByText('解除绑定'));
    expect(unbound).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('确认解除绑定'));

    expect(await screen.findByText('已解绑，只能与原搭档恢复')).toBeDefined();
    expect(JSON.parse(unbound.mock.calls[0]![0]!.body as string)).toEqual({
      expectedPeriodId: PERIOD,
    });
    expect(screen.queryByText('保存范围')).toBeNull();
  });

  it('[adr:spaces-and-invitations#9] says a space it may not read does not exist', async () => {
    stubApi({
      'GET /api/me': signedIn('carol'),
      [`GET /api/spaces/${SPACE}`]: errorBody('NOT_FOUND', 404),
      [`GET /api/spaces/${SPACE}/my-sharing`]: errorBody('NOT_FOUND', 404),
    });
    renderAt(`/spaces/${SPACE}`);
    expect((await screen.findByRole('alert')).textContent).toBe('找不到这个空间');
  });
});
