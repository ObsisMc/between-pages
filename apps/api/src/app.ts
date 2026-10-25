import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import swagger from '@fastify/swagger';
import {
  jsonSchemaTransform,
  jsonSchemaTransformObject,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { ApiErrorBody, routes, type RouteDefinition } from '@between-pages/contracts';
import { registerErrorHandling } from './errors.ts';
import { registerOriginGuard, requireUser, type CurrentUser } from './auth/guards.ts';
import { meHandler } from './routes/me.ts';

export interface AppDeps {
  /** The site browsers use, e.g. http://localhost:5173; the only trusted Origin. */
  publicOrigin: string;
  currentUser: CurrentUser;
  /** Better Auth's handler, mounted at /api/auth/* when given. */
  authHandler?: (request: Request) => Promise<Response>;
  logger?: FastifyServerOptions['logger'];
}

// Builds the app without listening so tests and the OpenAPI generator use the exact
// route registration that production serves.
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger ?? false }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorateRequest('user', null);
  registerErrorHandling(app);
  registerOriginGuard(app, deps.publicOrigin);

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: 'Between Pages API', version: '0.0.1' },
    },
    transform: jsonSchemaTransform,
    // Emits schemas that carry .meta({ id }) as components, so $refs resolve.
    transformObject: jsonSchemaTransformObject,
  });

  const guard = requireUser(deps.currentUser);
  // Registers a contract route; `access: 'user'` routes get the login guard and a 401
  // response in the contract (authentication-and-sessions invariant 13).
  const contractRoute = <R extends RouteDefinition>(
    route: R,
    handler: Parameters<typeof app.route>[0]['handler'],
  ) =>
    app.route({
      method: route.method,
      url: route.path,
      schema: {
        summary: route.summary,
        response:
          route.access === 'user'
            ? { 200: route.response, 401: ApiErrorBody }
            : { 200: route.response },
      },
      ...(route.access === 'user' ? { preHandler: guard } : {}),
      handler,
    });

  contractRoute(routes.health, () => ({ status: 'ok' as const }));
  contractRoute(routes.me, meHandler);

  if (deps.authHandler) {
    const handle = deps.authHandler;
    app.route({
      method: ['GET', 'POST'],
      url: '/api/auth/*',
      schema: { hide: true },
      handler: async (request, reply) => {
        const response = await handle(toWebRequest(request, deps.publicOrigin));
        reply.status(response.status);
        for (const [key, value] of response.headers) {
          if (key !== 'set-cookie') reply.header(key, value);
        }
        const cookies = response.headers.getSetCookie();
        if (cookies.length) reply.header('set-cookie', cookies);
        return reply.send(response.body ? await response.text() : null);
      },
    });
  }

  await app.ready();
  return app;
}

// Official Better Auth bridge: Fastify request → Web Request on the public origin.
function toWebRequest(
  request: { url: string; method: string; headers: object; body: unknown },
  origin: string,
) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) value.forEach((v) => headers.append(key, String(v)));
    else if (value !== undefined) headers.set(key, String(value));
  }
  return new Request(new URL(request.url, origin), {
    method: request.method,
    headers,
    ...(request.body ? { body: JSON.stringify(request.body) } : {}),
  });
}
