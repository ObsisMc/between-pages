import { PostgresAuthority } from '../postgres.mjs';
process.on('message', async ({ docId, actor, op, phase }) => {
  const pool = PostgresAuthority.pool(process.env.COLLAB_TEST_DATABASE_URL);
  const server = new PostgresAuthority(pool, docId);
  server[phase] = async () => {
    process.send({ phase });
    await new Promise(() => {}); // Parent kills this process at this exact durability boundary.
  };
  try { await server.submit(actor, op); }
  catch (error) { process.send({ error: error.message }); }
});
