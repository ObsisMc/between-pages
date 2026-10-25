import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ApiErrorBody, routes } from './index.ts';

const propertyNames = (schema: unknown): string[] => {
  if (!schema || typeof schema !== 'object') return [];
  const node = schema as Record<string, unknown>;
  const own =
    node.properties && typeof node.properties === 'object' ? Object.keys(node.properties) : [];
  return [...own, ...Object.values(node).flatMap(propertyNames)];
};

describe('route contracts', () => {
  it('rejects a health payload with an unknown status', () => {
    expect(routes.health.response.safeParse({ status: 'ok' }).success).toBe(true);
    expect(routes.health.response.safeParse({ status: 'degraded' }).success).toBe(false);
  });

  it('keeps every path unique so two handlers cannot claim one route', () => {
    const keys = Object.values(routes).map((route) => `${route.method} ${route.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('[adr:authentication-and-sessions#13] declares access on every route; only health is public', () => {
    for (const route of Object.values(routes)) expect(['public', 'user']).toContain(route.access);
    const publicRoutes = Object.entries(routes).filter(([, route]) => route.access === 'public');
    expect(publicRoutes.map(([name]) => name)).toEqual(['health']);
  });

  it('[adr:authentication-and-sessions#9] exposes no last-seen time in any response', () => {
    for (const route of Object.values(routes)) {
      const names = propertyNames(z.toJSONSchema(route.response)).map((n) => n.toLowerCase());
      expect(names.filter((n) => n.includes('lastseen') || n.includes('last_seen'))).toEqual([]);
    }
  });

  it('accepts only the known error codes', () => {
    const body = { error: { code: 'UNAUTHENTICATED', message: 'Sign in required' } };
    expect(ApiErrorBody.safeParse(body).success).toBe(true);
    expect(ApiErrorBody.safeParse({ error: { code: 'TEAPOT', message: '' } }).success).toBe(false);
  });
});
