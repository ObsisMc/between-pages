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
import { createBackupService, type DriveConfig } from './backup/backup.ts';
import { createBindingService } from './bindings/bindings.ts';
import { createClockService } from './clocks/clocks.ts';
import { createPokeService } from './pokes/pokes.ts';
import { createCommitService } from './commit/commit.ts';
import type { Db } from './db/client.ts';
import { createDiaryService } from './diaries/diaries.ts';
import { createEvents } from './events/events.ts';
import { createHistoryService } from './history/history.ts';
import { createReader } from './reader/reader.ts';
import { createReadingService } from './reading/reading.ts';
import { createReadingStore } from './store/reading.ts';
import { backupHandlers } from './routes/backup.ts';
import type { ContractRequest } from './routes/contract.ts';
import { diaryHandlers } from './routes/diaries.ts';
import { clockHandlers } from './routes/clocks.ts';
import { pokeHandlers } from './routes/pokes.ts';
import { meHandler } from './routes/me.ts';
import { spaceHandlers } from './routes/spaces.ts';
import { createSharingService } from './sharing/sharing.ts';
import { createSpaceRecords } from './space-records/space-records.ts';
import { createSpaceRecordStore } from './store/space-records.ts';
import { wishHandlers } from './routes/wishes.ts';
import { spaceRecordHandlers } from './routes/space-records.ts';
import { anniversaryHandlers } from './routes/anniversaries.ts';
import { createAnniversaryService } from './anniversaries/anniversaries.ts';
import { createReminderStore } from './store/anniversaries.ts';
import { createWishService } from './wishes/wishes.ts';
import { createBackupStore } from './store/backup.ts';
import { createCopyStore } from './store/copy.ts';
import { createClockStore } from './store/clocks.ts';
import { createPokeStore } from './store/pokes.ts';
import { createRelationStore } from './store/relations.ts';
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
  /** Shortens the history idle rule for the end-to-end suite; production keeps two minutes. */
  historyIdleMs?: number;
  /** Registers a listener for sessions that ended (`Auth.onSessionEnded`); their sockets close at once. */
  sessionEnded?: (listener: (sessionId: string) => void) => void;
  /** Google Drive for the readable copy; without it the backup page says "unavailable". */
  drive?: DriveConfig;
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
  // Auth knows nothing of events; the session-ended event is published here (kernel D10).
  deps.sessionEnded?.((sessionId) => events.publish({ type: 'session-ended', sessionId }));
  const diaries = createDiaryService(store);
  const reader = createReader(store);
  const commit = createCommitService(store);
  const backupService = createBackupService(
    createBackupStore(deps.db),
    createCopyStore(deps.db),
    deps.drive ?? null,
  );
  const handlers = diaryHandlers({
    backup: backupService,
    diaries,
    commit,
    reader,
    history: createHistoryService(reader, deps.historyIdleMs),
    reading: createReadingService(store, createReadingStore(deps.db)),
  });

  contractRoute('health', () => ({ status: 'ok' as const }));
  contractRoute('me', meHandler);
  contractRoute('diaries', handlers.diaries);
  contractRoute('openDiary', handlers.openDiary);
  contractRoute('diary', handlers.diary);
  contractRoute('receipt', handlers.receipt);
  contractRoute('history', handlers.history);
  contractRoute('historyVersion', handlers.historyVersion);
  contractRoute('readRanges', handlers.readRanges);
  contractRoute('reportRead', handlers.reportRead);
  contractRoute('sharedDiary', handlers.sharedDiary);
  contractRoute('character', handlers.character);
  contractRoute('sharedDiaries', handlers.sharedDiaries);
  contractRoute('days', handlers.days);
  contractRoute('nextUnread', handlers.nextUnread);
  contractRoute('day', handlers.day);

  const relations = createRelationStore(deps.db);
  const sharing = createSharingService(relations, store, events);
  const spaces = spaceHandlers({
    bindings: createBindingService(relations, sharing),
    sharing,
  });
  contractRoute('binding', spaces.binding);
  contractRoute('spaces', spaces.spaces);
  contractRoute('space', spaces.space);
  contractRoute('createInvitation', spaces.createInvitation);
  contractRoute('revokeInvitation', spaces.revokeInvitation);
  contractRoute('previewInvitation', spaces.previewInvitation);
  contractRoute('acceptInvitation', spaces.acceptInvitation);
  contractRoute('unbind', spaces.unbind);
  contractRoute('mySharing', spaces.mySharing);
  contractRoute('saveMySharing', spaces.saveMySharing);

  const clocks = clockHandlers(createClockService(createClockStore(deps.db)));
  contractRoute('clocks', clocks.clocks);
  contractRoute('reportTimezone', clocks.reportTimezone);
  contractRoute('saveSleep', clocks.saveSleep);

  const pokes = pokeHandlers(createPokeService(createPokeStore(deps.db)));
  contractRoute('pokes', pokes.pokes);
  contractRoute('sendPoke', pokes.sendPoke);
  contractRoute('seenPokes', pokes.seenPokes);

  const records = createSpaceRecords(createSpaceRecordStore(deps.db));
  const services = {
    records,
    wishes: createWishService(records),
    anniversaries: createAnniversaryService(records, createReminderStore(deps.db)),
  };
  const space = spaceRecordHandlers(services);
  contractRoute('spaceUnread', space.spaceUnread);
  contractRoute('reportSeen', space.reportSeen);
  const wishes = wishHandlers(services);
  contractRoute('wishes', wishes.wishes);
  contractRoute('createWish', wishes.createWish);
  contractRoute('editWish', wishes.editWish);
  contractRoute('deleteWish', wishes.deleteWish);
  contractRoute('receiveWish', wishes.receiveWish);
  contractRoute('prepareGift', wishes.prepareGift);
  contractRoute('editGift', wishes.editGift);
  contractRoute('deleteGift', wishes.deleteGift);
  contractRoute('revealGift', wishes.revealGift);
  contractRoute('saveGiftCard', wishes.saveGiftCard);
  contractRoute('setGiftDate', wishes.setGiftDate);
  contractRoute('setGiftOccasion', wishes.setGiftOccasion);
  const anniversaries = anniversaryHandlers(services);
  contractRoute('anniversaries', anniversaries.anniversaries);
  contractRoute('anniversary', anniversaries.anniversary);
  contractRoute('createAnniversary', anniversaries.createAnniversary);
  contractRoute('editAnniversary', anniversaries.editAnniversary);
  contractRoute('deleteAnniversary', anniversaries.deleteAnniversary);
  contractRoute('setAnniversaryDate', anniversaries.setAnniversaryDate);
  contractRoute('setAnniversaryCount', anniversaries.setAnniversaryCount);
  contractRoute('saveAnniversaryReminder', anniversaries.saveAnniversaryReminder);

  const backup = backupHandlers(backupService);
  contractRoute('backup', backup.backup);
  contractRoute('startGoogleConnection', backup.startGoogleConnection);
  contractRoute('finishGoogleConnection', backup.finishGoogleConnection);
  contractRoute('disconnectGoogle', backup.disconnectGoogle);
  contractRoute('runBackup', backup.runBackup);

  await app.register(websocket, { options: { maxPayload: TRANSPORT_MAX_BYTES } });
  registerSyncSocket(app, {
    publicOrigin: deps.publicOrigin,
    currentUser: deps.currentUser,
    diaries,
    reader,
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
