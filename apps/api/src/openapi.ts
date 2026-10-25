import { buildApp } from './app.ts';

// Serialized exactly as committed in apps/api/openapi.json, so a byte comparison
// detects any contract change that was not regenerated. Route registration needs no
// database or auth instance, so generation runs with an always-signed-out stand-in.
export async function renderOpenApi(): Promise<string> {
  const app = await buildApp({ publicOrigin: 'http://localhost', currentUser: async () => null });
  try {
    return `${JSON.stringify(app.swagger(), null, 2)}\n`;
  } finally {
    await app.close();
  }
}
