import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from 'fastify';
import swagger from '@fastify/swagger';
import websocket from '@fastify/websocket';
import {
  jsonSchemaTransform,
  jsonSchemaTransformObject,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { ApiErrorBody, routes, type RouteName } from '@between-pages/contracts';
import { registerErrorHandling } from './errors.ts';
import { registerOriginGuard, requireUser, type CurrentUser } from './auth/guards.ts';
import { createCommitService } from './commit/commit.ts';
import type { Db } from './db/client.ts';
import { createDiaryService } from './diaries/diaries.ts';
import { createEvents } from './events/events.ts';
import { createHistoryService } from './history/history.ts';
import type { ContractRequest } from './routes/contract.ts';
import { diaryHandlers } from './routes/diaries.ts';
import { meHandler } from './routes/me.ts';
import { createStore } from './store/store.ts';
import { TRANSPORT_MAX_BYTES, registerSyncSocket } from './ws/sync.ts';

export interface AppDeps {
  /** The site browsers use, e.g. http://localhost:5173; the only trusted Origin. */
  publicOrigin: string;
  currentUser: CurrentUser;
  /** Diary storage. Registering routes never queries it, so the OpenAPI generator passes an unconnected one. */
  db: Db;
  /** Better Auth's handler, mounted at /api/auth/* when given. */
  authHandler?: (request: Request) => Promise<Response>;
  logger?: FastifyServerOptions['logger'];
  /** Releases resources the caller owns (e.g. the database pool) when the app closes. */
  onClose?: () => Promise<void>;
}

// Builds the app without listening so tests and the OpenAPI generator use the exact
// route registration that production serves.
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger ?? false }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorateRequest('user', null);
  if (deps.onClose) {
    const onClose = deps.onClose;
    app.addHook('onClose', async () => onClose());
  }
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
  // response in the contract (authentication-and-sessions invariant 13). The guard runs
  // before validation, so a signed-out caller learns nothing from a 400.
  const contractRoute = <Name extends RouteName>(
    name: Name,
    handler: (request: ContractRequest<Name>, reply: FastifyReply) => unknown,
  ) => {
    const route = routes[name];
    app.route({
      method: route.method,
      url: route.path,
      schema: {
        summary: route.summary,
        ...('params' in route ? { params: route.params } : {}),
        ...('query' in route ? { querystring: route.query } : {}),
        ...('body' in route ? { body: route.body } : {}),
        response:
          route.access === 'user'
            ? { 200: route.response, 401: ApiErrorBody }
            : { 200: route.response },
      },
      ...(route.access === 'user' ? { preValidation: guard } : {}),
      // The schemas above have parsed params, query and body into these types.
      handler: handler as (request: FastifyRequest, reply: FastifyReply) => unknown,
    });
  };

  const store = createStore(deps.db);
  const events = createEvents();
  const diaries = createDiaryService(store);
  const commit = createCommitService(store);
  const handlers = diaryHandlers({ diaries, commit, history: createHistoryService(store) });

  contractRoute('health', () => ({ status: 'ok' as const }));
  contractRoute('me', meHandler);
  contractRoute('openDiary', handlers.openDiary);
  contractRoute('diary', handlers.diary);
  contractRoute('receipt', handlers.receipt);
  contractRoute('history', handlers.history);
  contractRoute('historyVersion', handlers.historyVersion);

  await app.register(websocket, { options: { maxPayload: TRANSPORT_MAX_BYTES } });
  registerSyncSocket(app, {
    publicOrigin: deps.publicOrigin,
    currentUser: deps.currentUser,
    diaries,
    commit,
    events,
  });

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
