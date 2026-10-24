import { createServer } from 'node:http';
import { Rejection } from './model.mjs';

// Transport probe, not a production auth implementation. Resolver is a trusted server dependency.
export function createAuthorityServer(authority, resolveSession) {
  return createServer(async (request, response) => {
    const send = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify(body));
    };
    try {
      const actor = await resolveSession(request.headers.authorization);
      if (!actor) return send(401, { error: 'UNAUTHENTICATED' });
      if (request.url === '/records' && request.method === 'GET') return send(200, await authority.read(actor));
      if (!['/operations', '/batch'].includes(request.url) || request.method !== 'POST') return send(404, { error: 'NOT_FOUND' });
      const chunks = []; let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 512 * 1024) return send(413, { error: 'REQUEST_TOO_LARGE' });
        chunks.push(chunk);
      }
      let op;
      try { op = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return send(400, { error: 'INVALID_JSON' }); }
      // Actor always comes from resolver. The operation schema refuses actor/author overrides.
      if (request.url === '/batch' && (Object.keys(op ?? {}).join() !== 'operations'))
        return send(400, { error: 'INVALID_BATCH_SHAPE' });
      const record = request.url === '/batch'
        ? await authority.submitBatch(actor, op.operations) : await authority.submit(actor, op);
      return send(200, record);
    } catch (error) {
      if (error instanceof Rejection) return send(error.code === 'FORBIDDEN' || error.code === 'FOREIGN_TEXT' ? 403 : 409, { error: error.code });
      return send(503, { error: 'RETRY_REQUIRED' });
    }
  });
}
export class HttpAuthority {
  constructor(url, token) { this.url = url; this.token = token; }
  async call(path, method, body) {
    const response = await fetch(`${this.url}${path}`, { method,
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json();
    if (!response.ok) {
      if (response.status < 500) throw new Rejection(result.error);
      throw new Error(result.error);
    }
    return result;
  }
  async read() { return this.call('/records', 'GET'); }
  async submit(_ignoredActor, op) { return this.call('/operations', 'POST', op); }
  async submitBatch(_ignoredActor, operations) { return this.call('/batch', 'POST', { operations }); }
}
