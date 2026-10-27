import 'fake-indexeddb/auto';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DIARY, FakeSocket, USER, diaryResponse, stubLocks } from '../../test/diary.ts';
import { renderAt, signedIn, stubApi } from '../../test/render.tsx';

const clipboard = { writeText: vi.fn<(text: string) => Promise<void>>(async () => undefined) };

afterEach(async () => {
  cleanup();
  FakeSocket.reset();
  clipboard.writeText.mockClear();
  vi.unstubAllGlobals();
  // Each test starts with an empty journal for the one signed-in user.
  await new Promise((resolve) => {
    indexedDB.deleteDatabase(`between-pages-journal:${USER}`).onsuccess = resolve;
  });
});

function openDiary(diary: () => Response = diaryResponse) {
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('navigator', { locks: stubLocks(), clipboard });
  stubApi({ 'GET /api/me': signedIn('alice'), [`GET /api/diaries/${DIARY}`]: diary });
  renderAt(`/diaries/${DIARY}`);
}

async function paste(content: string) {
  const editor = await screen.findByRole('textbox');
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: { getData: (type: string) => (type === 'text/plain' ? content : '') },
  });
  editor.dispatchEvent(event);
}

const status = () => screen.findByRole('status');

describe('DiaryPage', () => {
  it('says saved to the server only once the batch is acknowledged', async () => {
    openDiary();
    await waitFor(async () => expect((await status()).textContent).toBe('已保存到服务器'));
    FakeSocket.answer = () => 'hold';
    await paste('今天下雨');
    await waitFor(async () => expect((await status()).textContent).toBe('正在同步'));
    FakeSocket.release();
    await waitFor(async () => expect((await status()).textContent).toBe('已保存到服务器'));
  });

  it('lists refused input as a draft to copy and, after confirming, delete', async () => {
    openDiary();
    await waitFor(async () => expect((await status()).textContent).toBe('已保存到服务器'));
    FakeSocket.answer = () => 'EDIT_REJECTED';
    await paste('被拒的');

    const drafts = await screen.findByRole('region', { name: '恢复草稿' });
    expect(drafts.textContent).toContain('服务器没有接受这段输入');
    expect(drafts.textContent).toContain('被拒的');
    fireEvent.click(screen.getByText('复制新写的文字'));
    expect(clipboard.writeText).toHaveBeenCalledWith('被拒的');
    expect(await screen.findByText('已复制')).toBeDefined();

    fireEvent.click(screen.getByText('删除草稿'));
    expect(screen.queryByRole('region', { name: '恢复草稿' })).not.toBeNull();
    fireEvent.click(screen.getByText('确认删除这条草稿'));
    await waitFor(() => expect(screen.queryByRole('region', { name: '恢复草稿' })).toBeNull());
  });

  it('tells why a paste was refused', async () => {
    openDiary();
    await waitFor(async () => expect((await status()).textContent).toBe('已保存到服务器'));
    await paste('字'.repeat(300_000));
    expect((await screen.findByRole('alert')).textContent).toBe(
      '粘贴内容超过约 30 万字，请分段粘贴',
    );
  });

  it('says so when the diary does not exist for this user', async () => {
    openDiary(() =>
      Response.json({ error: { code: 'NOT_FOUND', message: 'No such diary' } }, { status: 404 }),
    );
    expect((await screen.findByRole('alert')).textContent).toBe('找不到这篇日记');
  });
});
