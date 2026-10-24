import * as Y from 'yjs';

// Spike: accept ordinary client Yjs updates, but only after checking them against
// the server's record of which Yjs clientIDs belong to which authenticated user.
// Item IDs carry their creator's clientID, so authorship and delete ownership can be
// read from the update itself without trusting any client-supplied author field.
export class Rejection extends Error {
  constructor(code, detail) { super(`${code}${detail ? `: ${detail}` : ''}`); this.code = code; }
}
const reject = (code, detail) => { throw new Rejection(code, detail); };

const ALLOWED_CONTENT = new Set(['ContentString', 'ContentType', 'ContentDeleted']);

export class Authority {
  constructor() {
    this.doc = new Y.Doc({ gc: false });
    this.owner = new Map(); // Yjs clientID -> userId, assigned by the server on first use
  }
  register(userId, clientId) {
    const current = this.owner.get(clientId);
    if (current && current !== userId) reject('CLIENT_ID_TAKEN', String(clientId));
    this.owner.set(clientId, userId);
  }
  check(userId, update) {
    const known = Y.encodeStateVector(this.doc);
    const serverClock = Y.decodeStateVector(known);
    const { structs, ds } = Y.decodeUpdate(update);
    for (const struct of structs) {
      const { client, clock } = struct.id;
      const alreadyHave = clock + struct.length <= (serverClock.get(client) ?? 0);
      if (alreadyHave) continue; // replay of something the server already accepted
      if (this.owner.get(client) !== userId) reject('FOREIGN_CLIENT_ID', `${client}`);
      if (struct.constructor.name !== 'Item') reject('UNEXPECTED_STRUCT', struct.constructor.name);
      const kind = struct.content.constructor.name;
      if (!ALLOWED_CONTENT.has(kind)) reject('CONTENT_NOT_ALLOWED', kind);
      if (struct.parentSub !== null) reject('ATTRIBUTE_WRITE', struct.parentSub);
    }
    for (const [client] of ds.clients)
      if (this.owner.get(client) !== userId) reject('FOREIGN_DELETE', `${this.owner.get(client)}:${client}`);
    // Every referenced ID must already exist (on the server or earlier in this update);
    // otherwise Yjs would park the update as pending, so it is refused instead.
    const clock = new Map(serverClock);
    const has = id => id === null || id.clock < (clock.get(id.client) ?? 0);
    for (const struct of structs) {
      const { client } = struct.id;
      if (struct.constructor.name === 'Item') {
        if (!has(struct.origin) || !has(struct.rightOrigin)) reject('MISSING_DEPENDENCY');
        if (struct.parent && typeof struct.parent === 'object' && 'client' in struct.parent && !has(struct.parent))
          reject('MISSING_DEPENDENCY');
      }
      if (struct.id.clock !== (clock.get(client) ?? 0) && struct.id.clock > (clock.get(client) ?? 0))
        reject('MISSING_DEPENDENCY');
      clock.set(client, Math.max(clock.get(client) ?? 0, struct.id.clock + struct.length));
    }
    for (const [client, ranges] of ds.clients)
      for (const { clock: start, len } of ranges)
        if (start + len > (clock.get(client) ?? 0)) reject('MISSING_DEPENDENCY');
  }
  accept(userId, update) {
    this.check(userId, update);
    Y.applyUpdate(this.doc, update, 'client');
  }
}
