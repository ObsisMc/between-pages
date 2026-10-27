import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ApiErrorBody, routes } from '@between-pages/contracts';
import { buildApp } from './app.ts';
import { createDb } from './db/client.ts';
import { renderOpenApi } from './openapi.ts';

const ORIGIN = 'http://localhost:5173';
const alice = {
  id: '6f1c1d0e-0000-4000-8000-000000000001',
  displayName: 'alice',
  sessionId: 'session-1',
};

// These routes never reach the database, so the pool never connects.
const database = createDb('postgresql://localhost/unused');
const db = database.db;

let signedOut: FastifyInstance;
let signedIn: FastifyInstance;
beforeAll(async () => {
  signedOut = await buildApp({ publicOrigin: ORIGIN, currentUser: async () => null, db });
  signedIn = await buildApp({ publicOrigin: ORIGIN, currentUser: async () => alice, db });
});
afterAll(async () => {
  await signedOut.close();
  await signedIn.close();
  await database.close();
});

describe('health route', () => {
  it('serves the contract response at the contract path without a session', async () => {
    const res = await signedOut.inject({ method: routes.health.method, url: routes.health.path });
    expect(res.statusCode).toBe(200);
    expect(routes.health.response.parse(res.json())).toEqual({ status: 'ok' });
  });
});

describe('access control', () => {
  it('[adr:authentication-and-sessions#13] answers 401 on every user route without a session', async () => {
    const userRoutes = Object.values(routes).filter((route) => route.access === 'user');
    expect(userRoutes.length).toBeGreaterThan(0);
    for (const route of userRoutes) {
      const res = await signedOut.inject({
        method: route.method,
        url: route.path,
        headers: { origin: ORIGIN },
      });
      expect(res.statusCode, route.path).toBe(401);
      expect(ApiErrorBody.parse(res.json()).error.code).toBe('UNAUTHENTICATED');
    }
  });

  it('returns the signed-in user from /api/me without private fields', async () => {
    const res = await signedIn.inject({ method: 'GET', url: routes.me.path });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ user: { id: alice.id, displayName: alice.displayName } });
  });
});

describe('origin guard', () => {
  it('[adr:authentication-and-sessions#7] refuses state-changing requests from another or no origin', async () => {
    const evil = await signedIn.inject({
      method: 'POST',
      url: '/api/anything',
      headers: { origin: 'https://evil.example' },
    });
    expect(evil.statusCode).toBe(403);
    expect(ApiErrorBody.parse(evil.json()).error.code).toBe('FORBIDDEN_ORIGIN');
    const missing = await signedIn.inject({ method: 'DELETE', url: '/api/anything' });
    expect(missing.statusCode).toBe(403);
    const trusted = await signedIn.inject({
      method: 'POST',
      url: '/api/anything',
      headers: { origin: ORIGIN },
    });
    expect(trusted.statusCode).toBe(404);
  });

  it('leaves reads alone', async () => {
    const res = await signedIn.inject({
      method: 'GET',
      url: routes.me.path,
      headers: { origin: 'https://evil.example' },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('error format', () => {
  it('answers unknown routes with the contract error body', async () => {
    const res = await signedIn.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(ApiErrorBody.parse(res.json()).error.code).toBe('NOT_FOUND');
  });

  it('hides internal errors behind INTERNAL', async () => {
    const broken = await buildApp({
      publicOrigin: ORIGIN,
      currentUser: async () => {
        throw new Error('database password is hunter2');
      },
      db,
    });
    const res = await broken.inject({ method: 'GET', url: routes.me.path });
    await broken.close();
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: { code: 'INTERNAL', message: 'Internal error' } });
  });
});

describe('OpenAPI document', () => {
  it('describes every contract route', async () => {
    const doc = JSON.parse(await renderOpenApi()) as { paths: Record<string, unknown> };
    for (const route of Object.values(routes)) {
      const path = route.path.replace(/:(\w+)/g, '{$1}');
      expect(doc.paths).toHaveProperty([path, route.method.toLowerCase()]);
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
