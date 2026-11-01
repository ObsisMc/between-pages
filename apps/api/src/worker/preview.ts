import { readPreview, type Preview } from '../link-preview/link-preview.ts';
import type { PreviewStore } from '../store/wishes.ts';

/**
 * Reads the links nobody has read yet, one at a time, and stores what each gave (wishes-and-
 * gifts D7); a link that cannot be read is stored as read with nothing, so it is not tried
 * again until it changes. Returns how many it took.
 */
export async function previewNext(
  store: PreviewStore,
  read: (link: string) => Promise<Preview | null> = readPreview,
): Promise<number> {
  const pending = await store.pending();
  for (const item of pending) await store.save(item, await read(item.link), new Date());
  return pending.length;
}
