import { buildApp, requestLog } from './app.ts';
import { createAuth } from './auth/auth.ts';
import { createCurrentUser } from './auth/current-user.ts';
import { driveConfig } from './backup/drive-config.ts';
import { parseConfig } from './config.ts';
import { createDb } from './db/client.ts';

// Refuses to start on a bad configuration and names every offending variable (D11).
const config = parseConfig(process.env);
const database = createDb(config.DATABASE_URL);
const auth = createAuth(config, database.db);

const app = await buildApp({
  publicOrigin: config.publicOrigin,
  currentUser: createCurrentUser(auth, database.db),
  db: database.db,
  authHandler: (request) => auth.handler(request),
  sessionEnded: (listener) => auth.onSessionEnded(listener),
  logger: requestLog,
  onClose: () => database.close(),
  ...(config.HISTORY_IDLE_MS ? { historyIdleMs: config.HISTORY_IDLE_MS } : {}),
  ...(driveConfig(config) ? { drive: driveConfig(config)! } : {}),
  ...(config.MAIL_TOKEN_KEY ? { mailTokenKey: Buffer.from(config.MAIL_TOKEN_KEY, 'base64') } : {}),
});
await app.listen({ port: config.PORT, host: config.HOST });
