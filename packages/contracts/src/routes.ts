import { z } from 'zod';

// Every HTTP route the web client may call. The API registers handlers from these
// definitions and the client builds requests from them, so the path, method and
// response shape cannot drift apart.
export interface RouteDefinition<Response extends z.ZodType = z.ZodType> {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: `/api/${string}`;
  summary: string;
  response: Response;
}

export const HealthResponse = z
  .object({
    status: z.literal('ok'),
  })
  .meta({ id: 'HealthResponse' });

export const routes = {
  health: {
    method: 'GET',
    path: '/api/health',
    summary: 'Report that the API process is serving requests.',
    response: HealthResponse,
  },
} as const satisfies Record<string, RouteDefinition>;

export type RouteName = keyof typeof routes;
export type ResponseOf<Name extends RouteName> = z.infer<(typeof routes)[Name]['response']>;
