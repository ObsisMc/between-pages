import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { noRelationship, renderAt, stubApi } from '../../test/render.tsx';

// 设置 → 我的名字 (display-name D2, D3, D7) on the real routes, under the real site header.

const ID = '6f1c1d0e-0000-4000-8000-000000000001';
const bodyOf = (init?: RequestInit) => JSON.parse(String(init?.body)) as { displayName: string };
const refusal = () =>
  Response.json({ error: { code: 'VALIDATION_FAILED', message: 'bad' } }, { status: 400 });

/** The API as one person: GET /api/me says whatever the last PATCH saved. */
function stubPerson(patch?: (init?: RequestInit) => Response) {
  let name = 'alice';
  return stubApi({
    ...noRelationship,
    'GET /api/me': () => Response.json({ user: { id: ID, displayName: name } }),
    'PATCH /api/me': (init) => {
      if (patch) return patch(init);
      name = bodyOf(init).displayName.trim();
      return Response.json({ user: { id: ID, displayName: name } });
    },
  });
}
const input = () => screen.getByLabelText('名字') as HTMLInputElement;
const type = (value: string) => fireEvent.change(input(), { target: { value } });
const save = () => fireEvent.click(screen.getByRole('button', { name: '保存' }));
const patches = (fetch: ReturnType<typeof stubApi>) =>
  fetch.mock.calls.filter(([, init]) => init?.method === 'PATCH');

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('NamePage', () => {
  it('[adr:display-name#2] says why a name cannot be saved and sends nothing', async () => {
    const fetch = stubPerson();
    renderAt('/name');
    expect(await screen.findByRole('heading', { level: 1, name: '我的名字' })).toBeDefined();
    expect(input().value).toBe('alice');
    expect(screen.getByText(/对方会看到这个名字/)).toBeDefined();

    for (const [value, text] of [
      ['   ', '名字不能为空'],
      ['一'.repeat(21), '名字最多 20 个字'],
      ['​', '名字里要有看得见的字'],
    ]) {
      type(value!);
      save();
      expect((await screen.findByRole('alert')).textContent).toBe(text);
    }
    expect(patches(fetch)).toHaveLength(0);
  });

  it('[adr:display-name#3] shows the new name everywhere on screen without reloading', async () => {
    const fetch = stubPerson();
    renderAt('/name');
    expect(await screen.findByRole('button', { name: '账号：alice' })).toBeDefined();
    const bindingReads = () =>
      fetch.mock.calls.filter(([url]) => String(url) === '/api/binding').length;
    const before = bindingReads();

    type(' 小雨 ');
    save();
    expect(await screen.findByText('已保存')).toBeDefined();
    expect(bodyOf(patches(fetch)[0]![1])).toEqual({ displayName: ' 小雨 ' });
    expect(await screen.findByRole('button', { name: '账号：小雨' })).toBeDefined();
    expect(input().value).toBe('小雨');
    // Every cached answer is read again, so a name inside any of them is fresh too.
    await waitFor(() => expect(bindingReads()).toBeGreaterThan(before));
  });

  it('says the server’s refusal and a failed save in words, keeping the input', async () => {
    let answer = refusal;
    stubPerson(() => answer());
    renderAt('/name');
    await screen.findByRole('heading', { level: 1, name: '我的名字' });
    type('小雨');
    save();
    expect((await screen.findByRole('alert')).textContent).toBe('这个名字不能用，请换一个');
    answer = () => new Response(null, { status: 500 });
    save();
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('没能保存，请稍后再试'));
    expect(input().value).toBe('小雨');
  });

  it('is listed under 设置 whether or not there is a partner', async () => {
    stubPerson();
    renderAt('/name');
    fireEvent.pointerDown(await screen.findByRole('button', { name: /设置/ }), {
      button: 0,
      ctrlKey: false,
    });
    expect(await screen.findByRole('menuitem', { name: '我的名字' })).toBeDefined();
  });
});
