import { buildApp } from './app.ts';
import { createDb } from './db/client.ts';

// Serialized exactly as committed in apps/api/openapi.json, so a byte comparison
// detects any contract change that was not regenerated. Route registration needs no
// auth instance and never queries the database, so generation runs with an
// always-signed-out stand-in and a pool that never connects.
export async function renderOpenApi(): Promise<string> {
  const database = createDb('postgresql://localhost/unused');
  const app = await buildApp({
    publicOrigin: 'http://localhost',
    currentUser: async () => null,
    db: database.db,
    onClose: () => database.close(),
  });
  try {
    return `${JSON.stringify(app.swagger(), null, 2)}\n`;
  } finally {
    await app.close();
  }
}
