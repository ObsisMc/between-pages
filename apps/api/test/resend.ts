import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

// A stand-in for Resend's POST /emails (email-reminders 落地顺序 1). By default it behaves
// as Resend does with idempotency keys: the same key and body answer the first result,
// the same key with another body is 409 invalid_idempotent_request. A test queues other
// answers with `next`; `accept-then-drop` accepts the mail and then cuts the connection,
// as when an answer is lost after Resend took the mail.

export type FakeRequest = {
  key: string | undefined;
  body: {
    from: string;
    to: string | string[];
    subject: string;
    html: string;
    text: string;
    headers?: Record<string, string>;
  };
};

type Answer =
  { status: number; body: object; headers?: Record<string, string> } | 'accept-then-drop' | 'drop';

const read = (request: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => resolve(body));
  });

export async function startFakeResend() {
  const requests: FakeRequest[] = [];
  /** Mails Resend took, one per idempotency key: what recipients get. */
  const delivered = new Map<string, { id: string; raw: string; body: FakeRequest['body'] }>();
  const queue: Answer[] = [];
  let ids = 0;

  const server = createServer(async (request, response) => {
    const raw = await read(request);
    const key = request.headers['idempotency-key'] as string | undefined;
    const body = JSON.parse(raw) as FakeRequest['body'];
    requests.push({ key, body });
    const answer = queue.shift();
    const accept = () => {
      const kept = key ? delivered.get(key) : undefined;
      if (kept && kept.raw !== raw) return null;
      const id = kept?.id ?? `email-${++ids}`;
      if (!kept) delivered.set(key ?? id, { id, raw, body });
      return id;
    };
    if (answer === 'drop') return request.socket.destroy();
    if (answer === 'accept-then-drop') {
      accept();
      return request.socket.destroy();
    }
    if (answer) {
      response.writeHead(answer.status, { 'content-type': 'application/json', ...answer.headers });
      return response.end(JSON.stringify(answer.body));
    }
    const id = accept();
    if (!id) {
      response.writeHead(409, { 'content-type': 'application/json' });
      return response.end(
        JSON.stringify({
          name: 'invalid_idempotent_request',
          statusCode: 409,
          message: 'Same idempotency key used with a different request payload.',
        }),
      );
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ id }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    delivered,
    /** Answers the next request with `answer` instead of the default. */
    next(answer: Answer) {
      queue.push(answer);
    },
    reset() {
      requests.length = 0;
      delivered.clear();
      queue.length = 0;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export type FakeResend = Awaited<ReturnType<typeof startFakeResend>>;

/** Resend's error body for `name` with `status`. */
export const resendError = (status: number, name: string, headers?: Record<string, string>) => ({
  status,
  body: { name, statusCode: status, message: name },
  ...(headers ? { headers } : {}),
});
