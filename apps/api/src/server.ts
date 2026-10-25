import { buildApp } from './app.ts';
import { createAuth } from './auth/auth.ts';
import { createCurrentUser } from './auth/current-user.ts';
import { parseConfig } from './config.ts';
import { createDb } from './db/client.ts';

// Refuses to start on a bad configuration and names every offending variable (D11).
const config = parseConfig(process.env);
const database = createDb(config.DATABASE_URL);
const auth = createAuth(config, database.db);

const app = await buildApp({
  publicOrigin: config.publicOrigin,
  currentUser: createCurrentUser(auth, database.db),
  authHandler: (request) => auth.handler(request),
  logger: true,
  onClose: () => database.close(),
});
await app.listen({ port: config.PORT, host: config.HOST });
