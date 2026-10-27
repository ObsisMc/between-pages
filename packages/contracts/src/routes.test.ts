import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ApiErrorBody, ServerMessage, TimeZone, routes } from './index.ts';

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

  it('[adr:diary-collaboration-kernel#15] exposes no internal version in any response or server message', () => {
    const schemas = [...Object.values(routes).map((route) => route.response), ServerMessage];
    for (const schema of schemas) {
      const names = propertyNames(z.toJSONSchema(schema)).map((n) => n.toLowerCase());
      expect(names.filter((n) => n.includes('version'))).toEqual([]);
    }
  });

  it('names every path parameter in the route params schema', () => {
    for (const route of Object.values(routes)) {
      const segments = [...route.path.matchAll(/:(\w+)/g)].map((m) => m[1]);
      const params = 'params' in route ? Object.keys(z.toJSONSchema(route.params).properties!) : [];
      expect(params.sort(), route.path).toEqual(segments.sort());
    }
  });

  it('accepts IANA time zones only', () => {
    expect(TimeZone.safeParse('Asia/Shanghai').success).toBe(true);
    expect(TimeZone.safeParse('America/Los_Angeles').success).toBe(true);
    expect(TimeZone.safeParse('Mars/Olympus').success).toBe(false);
    expect(TimeZone.safeParse('+08:00').success).toBe(false);
  });

  it('accepts only the known error codes', () => {
    const body = { error: { code: 'UNAUTHENTICATED', message: 'Sign in required' } };
    expect(ApiErrorBody.safeParse(body).success).toBe(true);
    expect(ApiErrorBody.safeParse({ error: { code: 'TEAPOT', message: '' } }).success).toBe(false);
  });

  it('[adr:spaces-and-invitations#9] carries a sharing range only in the owner’s own range response', () => {
    const withRange = Object.entries(routes)
      .filter(([, route]) => {
        const names = propertyNames(z.toJSONSchema(route.response));
        return names.includes('include') || names.includes('exclude');
      })
      .map(([name]) => name);
    expect(withRange).toEqual(['mySharing']);
  });
});
