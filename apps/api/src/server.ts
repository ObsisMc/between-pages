import { buildApp } from './app.ts';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';

// Signed-out stand-in until the Better Auth wiring lands; every user route answers 401.
const app = await buildApp({
  publicOrigin: process.env.PUBLIC_ORIGIN ?? 'http://localhost:5173',
  currentUser: async () => null,
  logger: true,
});
await app.listen({ port, host });
