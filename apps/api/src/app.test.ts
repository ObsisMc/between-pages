import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { routes } from '@between-pages/contracts';
import { buildApp } from './app.ts';
import { renderOpenApi } from './openapi.ts';

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp();
});
afterAll(async () => {
  await app.close();
});

describe('health route', () => {
  it('serves the contract response at the contract path', async () => {
    const res = await app.inject({ method: routes.health.method, url: routes.health.path });
    expect(res.statusCode).toBe(200);
    expect(routes.health.response.parse(res.json())).toEqual({ status: 'ok' });
  });
});

describe('OpenAPI document', () => {
  it('describes every contract route', async () => {
    const doc = JSON.parse(await renderOpenApi()) as { paths: Record<string, unknown> };
    for (const route of Object.values(routes)) {
      expect(doc.paths).toHaveProperty([route.path, route.method.toLowerCase()]);
    }
  });

  it('defines every schema it references', async () => {
    const text = await renderOpenApi();
    const doc = JSON.parse(text) as { components?: { schemas?: Record<string, unknown> } };
    const refs = [...text.matchAll(/"#\/components\/schemas\/([^"]+)"/g)].map((m) => m[1]);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect(doc.components?.schemas).toHaveProperty([ref!]);
  });
});
