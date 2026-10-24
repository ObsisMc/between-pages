import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { WebSocketServer, WebSocket } from 'ws';
import { createAuthorityServer } from '../http.mjs';
import { MemoryAuthority } from '../authority.mjs';
import { Document, ROOT } from '../model.mjs';
import { PostgresAuthority } from '../postgres.mjs';

export async function startHarness({ pool = null } = {}) {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('./editor.mjs', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022' });
  const html = await readFile(new URL('./index.html', import.meta.url));
  const serviceWorker = await readFile(new URL('./sw.js', import.meta.url));
  const documents = new Map(), rooms = new Map();
  const sessions = new Map([['probe-A', 'A'], ['probe-B', 'B'], ['probe-C', 'C']]);
  const auth = header => sessions.get(header?.replace(/^Bearer /, ''));
  async function authority(id) {
    if (!documents.has(id)) documents.set(id, (async () => {
      let base;
      if (pool) { base = new PostgresAuthority(pool, id); await base.create(); }
      else base = new MemoryAuthority();
      const submit = base.submitBatch.bind(base);
      base.submitBatch = async (actor, operations) => {
        const result = await submit(actor, operations);
        broadcast(id, { type: 'changed' }); return result;
      };
      return base;
    })());
    return documents.get(id);
  }
  function broadcast(doc, payload, except = null) {
    for (const connection of rooms.get(doc) ?? []) if (connection !== except && connection.readyState === WebSocket.OPEN)
      connection.send(JSON.stringify(payload));
  }
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/' || url.pathname === '/index.html') {
        response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }); response.end(html); return;
      }
      if (url.pathname === '/sw.js') {
        response.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' }); response.end(serviceWorker); return;
      }
      if (url.pathname === '/bundle.js') {
        response.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' }); response.end(bundle.outputFiles[0].contents); return;
      }
      const match = url.pathname.match(/^\/api\/([a-zA-Z0-9-]{1,100})\/(records|operations|batch)$/);
      if (!match) { response.writeHead(404); response.end(); return; }
      const base = await authority(match[1]);
      request.url = `/${match[2]}`;
      createAuthorityServer(base, auth).emit('request', request, response);
    } catch (error) { response.writeHead(500); response.end(JSON.stringify({ error: error.message })); }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  server.on('upgrade', async (request, socket, head) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      const doc = url.searchParams.get('doc'), token = url.searchParams.get('token');
      if (url.pathname !== '/live' || !/^[a-zA-Z0-9-]{1,100}$/.test(doc ?? '')) throw new Error('INVALID_ROOM');
      const actor = sessions.get(token), base = await authority(doc);
      await base.read(actor);
      wss.handleUpgrade(request, socket, head, connection => {
        connection.identity = { doc, actor, token, session: url.searchParams.get('session') };
        wss.emit('connection', connection);
      });
    } catch { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); }
  });
  wss.on('connection', connection => {
    const { doc, actor, token, session } = connection.identity;
    if (!rooms.has(doc)) rooms.set(doc, new Set());
    rooms.get(doc).add(connection);
    for (const peer of rooms.get(doc)) if (peer.presence) connection.send(JSON.stringify(peer.presence));
    connection.on('message', async raw => {
      try {
        if (sessions.get(token) !== actor) { connection.close(1008, 'expired'); return; }
        const base = await authority(doc), records = await base.read(actor);
        const data = JSON.parse(raw.toString()), document = new Document(records);
        const valid = p => p && typeof p === 'object' && (p.left === ROOT || document.atoms.has(p.left))
          && (p.right === null || document.atoms.has(p.right)) && ['left', 'right'].includes(p.bias);
        if (data.type !== 'presence' || !valid(data.anchor) || !valid(data.head)) return;
        connection.presence = { type: 'presence', session, actor, anchor: data.anchor, head: data.head };
        broadcast(doc, connection.presence, connection);
      } catch { connection.close(1008, 'invalid'); }
    });
    connection.on('close', () => { rooms.get(doc).delete(connection); broadcast(doc, { type: 'leave', session }); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, sessions, authority,
    async close() {
      for (const connection of wss.clients) connection.terminate();
      await new Promise(resolve => wss.close(resolve));
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    } };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const harness = await startHarness(); console.log(`Validation harness: ${harness.url}/?actor=A&doc=manual`);
}
