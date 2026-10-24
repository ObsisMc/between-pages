import { buildApp } from './app.ts';

// Serialized exactly as committed in apps/api/openapi.json, so a byte comparison
// detects any contract change that was not regenerated.
export async function renderOpenApi(): Promise<string> {
  const app = await buildApp();
  try {
    return `${JSON.stringify(app.swagger(), null, 2)}\n`;
  } finally {
    await app.close();
  }
}
