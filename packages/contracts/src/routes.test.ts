import { describe, expect, it } from 'vitest';
import { routes } from './index.ts';

describe('route contracts', () => {
  it('rejects a health payload with an unknown status', () => {
    expect(routes.health.response.safeParse({ status: 'ok' }).success).toBe(true);
    expect(routes.health.response.safeParse({ status: 'degraded' }).success).toBe(false);
  });

  it('keeps every path unique so two handlers cannot claim one route', () => {
    const keys = Object.values(routes).map((route) => `${route.method} ${route.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
