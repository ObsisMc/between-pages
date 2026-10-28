import type { FastifyInstance } from 'fastify';
import { ServerMessage, syncSocket } from '@between-pages/contracts';

export type Socket = Awaited<ReturnType<typeof connectSocket>>;

/**
 * A client of the sync socket through the app's real handler, queueing every server
 * message parsed with the contract. `next` waits up to 3 s; `quiet` asserts nothing more
 * arrives within `ms`.
 */
export async function connectSocket(app: FastifyInstance, cookie: string, origin: string) {
  const inbox: ServerMessage[] = [];
  const waiting: ((message: ServerMessage) => void)[] = [];
  let resolveClosed: (code: number) => void;
  const closed = new Promise<number>((resolve) => (resolveClosed = resolve));
  const ws = await app.injectWS(
    syncSocket.path,
    { headers: { origin, cookie } },
    {
      onInit(socket) {
        socket.on('message', (data: Buffer) => {
          const message = ServerMessage.parse(JSON.parse(String(data)));
          const waiter = waiting.shift();
          if (waiter) waiter(message);
          else inbox.push(message);
        });
        socket.on('close', (code: number) => resolveClosed(code));
      },
    },
  );
  return {
    send: (message: unknown) =>
      ws.send(typeof message === 'string' ? message : JSON.stringify(message)),
    next: () =>
      new Promise<ServerMessage>((resolve, reject) => {
        const queued = inbox.shift();
        if (queued) return resolve(queued);
        waiting.push(resolve);
        setTimeout(() => reject(new Error('no message within 3 s')), 3000).unref();
      }),
    /** Resolves with whatever arrived unread after `ms`; an empty list means silence. */
    quiet: (ms: number) =>
      new Promise<ServerMessage[]>((resolve) =>
        setTimeout(() => resolve(inbox.splice(0)), ms).unref(),
      ),
    closed,
    close: () => ws.terminate(),
  };
}
