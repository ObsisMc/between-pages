import { z } from 'zod';

// Every HTTP route the web client may call. The API registers handlers from these
// definitions and the client builds requests from them, so the path, method and
// response shape cannot drift apart.
export interface RouteDefinition<Response extends z.ZodType = z.ZodType> {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: `/api/${string}`;
  summary: string;
  // 'user' routes answer 401 without a session; public ones must say so explicitly
  // (authentication-and-sessions invariant 13).
  access: 'public' | 'user';
  response: Response;
}

export const HealthResponse = z
  .object({
    status: z.literal('ok'),
  })
  .meta({ id: 'HealthResponse' });

// What one member may learn about a user. Never add last-seen time or login data here
// (authentication-and-sessions invariant 9).
export const UserSummary = z
  .object({
    id: z.uuid(),
    displayName: z.string(),
  })
  .meta({ id: 'UserSummary' });

export const MeResponse = z.object({ user: UserSummary }).meta({ id: 'MeResponse' });

export const routes = {
  health: {
    method: 'GET',
    path: '/api/health',
    summary: 'Report that the API process is serving requests.',
    access: 'public',
    response: HealthResponse,
  },
  me: {
    method: 'GET',
    path: '/api/me',
    summary: 'Return the signed-in user.',
    access: 'user',
    response: MeResponse,
  },
} as const satisfies Record<string, RouteDefinition>;

export type RouteName = keyof typeof routes;
export type ResponseOf<Name extends RouteName> = z.infer<(typeof routes)[Name]['response']>;
