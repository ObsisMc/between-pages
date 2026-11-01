import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Database } from '../db/client.ts';
import { createSpaceRecords } from '../space-records/space-records.ts';
import { createSpaceRecordStore } from '../store/space-records.ts';
import { createPreviewStore } from '../store/wishes.ts';
import { createWishService } from '../wishes/wishes.ts';
import { query, testDatabaseUrl } from '../../test/db.ts';
import { createUser } from '../../test/diary.ts';
import { previewNext } from './preview.ts';

// The worker's link-preview task (wishes-and-gifts D7) on real PostgreSQL.

let database: Database;
beforeAll(() => {
  if (testDatabaseUrl) database = createDb(testDatabaseUrl);
});
afterAll(() => database?.close());

describe.runIf(testDatabaseUrl)('link preview task', () => {
  it('[adr:wishes-and-gifts#7] stores what a link gave, only while the link is still the one read', async () => {
    const [a, b] = [await createUser('A'), await createUser('B')].sort() as [string, string];
    const [space, period] = [randomUUID(), randomUUID()];
    await query('insert into spaces (id, user_low, user_high) values ($1, $2, $3)', [space, a, b]);
    await query('insert into binding_periods (id, space_id) values ($1, $2)', [period, space]);
    const wishes = createWishService(createSpaceRecords(createSpaceRecordStore(database.db)));
    const store = createPreviewStore(database.db);
    const created = await wishes.createWish(a, {
      requestId: randomUUID(),
      name: '围巾',
      link: 'https://shop.example/a',
      note: null,
      want: null,
    });
    if (typeof created === 'string') throw new Error(created);

    // The wisher changes the link while the worker is reading the old one.
    let edited = false;
    await previewNext(store, async (link) => {
      if (link === 'https://shop.example/a' && !edited) {
        edited = true;
        await wishes.editWish(a, created.id, {
          expectedRevision: 1,
          name: '围巾',
          link: 'https://shop.example/b',
          note: null,
          want: null,
        });
      }
      return { title: `title of ${link}`, site: 'Shop', image: null };
    });
    const pending = await wishes.view(a);
    if (pending === 'NOT_FOUND') throw new Error(pending);
    expect(pending.mine[0]!.preview).toMatchObject({ state: 'pending' });

    await previewNext(store, async (link) => ({
      title: `title of ${link}`,
      site: 'Shop',
      image: null,
    }));
    // Unreadable links are stored as read with nothing, and not tried again.
    await wishes.createWish(a, {
      requestId: randomUUID(),
      name: '读不到',
      link: 'https://blocked.example/',
      note: null,
      want: null,
    });
    await previewNext(store, async () => null);
    expect(
      await previewNext(store, async () => ({ title: 'again', site: null, image: null })),
    ).toBe(0);

    const ready = await wishes.view(a);
    if (ready === 'NOT_FOUND') throw new Error(ready);
    const byName = new Map(ready.mine.map((w) => [w.name, w.preview]));
    expect(byName.get('围巾')).toEqual({
      state: 'ready',
      title: 'title of https://shop.example/b',
      site: 'Shop',
      image: null,
    });
    expect(byName.get('读不到')).toEqual({ state: 'ready', title: null, site: null, image: null });
  });
});
