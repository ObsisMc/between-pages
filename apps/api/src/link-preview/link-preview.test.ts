import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { BlockList } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseHead, readPreview } from './link-preview.ts';

// Link previews (wishes-and-gifts D7, invariant 7) against a local server. Tests let the
// reader reach 127.0.0.1 through a narrower block list; the default list is checked on its own.

const PAGE = `<!doctype html><html><head>
  <meta charset="utf-8">
  <meta property="og:title" content="灰色羊毛围巾 &amp; 手套">
  <meta property="og:site_name" content='小店'>
  <meta property="og:image" content="/img/scarf.jpg">
  <title>ignored</title>
</head><body>${'x'.repeat(10)}</body></html>`;

let server: Server;
let base: string;
const handlers = new Map<string, (res: import('node:http').ServerResponse) => void>();
beforeAll(async () => {
  server = createServer((req, res) => {
    const handle = handlers.get(req.url ?? '');
    if (handle) return handle(res);
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

/** Everything the default list blocks except loopback, so the local server is reachable. */
const exceptLoopback = () => {
  const list = new BlockList();
  list.addSubnet('10.0.0.0', 8, 'ipv4');
  list.addSubnet('169.254.0.0', 16, 'ipv4');
  list.addSubnet('192.168.0.0', 16, 'ipv4');
  return list;
};
const resolveTo = (address: string): typeof import('node:dns').lookup =>
  ((
    _host: string,
    _opts: unknown,
    callback: (e: null, a: { address: string; family: number }[]) => void,
  ) => callback(null, [{ address, family: address.includes(':') ? 6 : 4 }])) as never;
const html = (body: string) => (res: import('node:http').ServerResponse) =>
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
const redirect = (to: string) => (res: import('node:http').ServerResponse) =>
  res.writeHead(302, { location: to }).end();

describe('link previews', () => {
  it('[adr:wishes-and-gifts#7] takes Open Graph text and an https image, decoding entities', () => {
    expect(parseHead(PAGE, new URL('https://shop.example/item/1'))).toEqual({
      title: '灰色羊毛围巾 & 手套',
      site: '小店',
      image: 'https://shop.example/img/scarf.jpg',
    });
    const plain = parseHead(
      '<head><title> A  page </title><meta name="og:image" content="http://insecure.example/a.png"></head>',
      new URL('https://shop.example/'),
    );
    expect(plain).toEqual({ title: 'A page', site: null, image: null });
  });

  it('[adr:wishes-and-gifts#7] reads a public page, following up to three redirects', async () => {
    handlers.set('/page', html(PAGE));
    handlers.set('/r1', redirect('/r2'));
    handlers.set('/r2', redirect('/r3'));
    handlers.set('/r3', redirect('/page'));
    handlers.set('/r0', redirect('/r1'));
    const options = { blocked: exceptLoopback() };
    expect(await readPreview(`${base}/r1`, options)).toMatchObject({
      title: '灰色羊毛围巾 & 手套',
    });
    expect(await readPreview(`${base}/r0`, options)).toBeNull();
  });

  it('[adr:wishes-and-gifts#7] refuses internal addresses: literal, by name, after a redirect', async () => {
    handlers.set('/to-internal', redirect('http://10.1.2.3/admin'));
    handlers.set('/to-metadata-name', redirect('http://metadata.test/latest'));
    handlers.set('/page', html(PAGE));
    const port = new URL(base).port;
    // The default list blocks loopback in every spelling.
    for (const link of [
      `${base}/page`,
      `http://localhost:${port}/page`,
      `http://[::ffff:127.0.0.1]:${port}/page`,
      `http://[::1]:${port}/page`,
    ])
      expect(await readPreview(link)).toBeNull();
    const options = { blocked: exceptLoopback() };
    expect(await readPreview(`${base}/to-internal`, options)).toBeNull();
    expect(
      await readPreview(`${base}/to-metadata-name`, {
        ...options,
        resolve: resolveTo('169.254.169.254'),
      }),
    ).toBeNull();
    // A public-looking name that resolves to a private address is refused before connecting.
    expect(
      await readPreview(`http://shop.test:${port}/page`, {
        ...options,
        resolve: resolveTo('192.168.1.1'),
      }),
    ).toBeNull();
    expect(
      await readPreview(`http://shop.test:${port}/page`, {
        ...options,
        resolve: resolveTo('127.0.0.1'),
      }),
    ).toMatchObject({ site: '小店' });
    expect(await readPreview('ftp://shop.example/page', options)).toBeNull();
  });

  it('[adr:wishes-and-gifts#7] stops at the time limit, the size cap, and anything not HTML', async () => {
    handlers.set('/hang', () => undefined);
    handlers.set('/json', (res) =>
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}'),
    );
    handlers.set('/huge', (res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.write('<head><title>Big</title>');
      const chunk = 'x'.repeat(64 * 1024);
      const pump = () => {
        while (res.write(chunk));
        res.once('drain', pump);
      };
      pump();
      res.on('close', () => res.removeAllListeners('drain'));
    });
    const options = { blocked: exceptLoopback() };
    const started = Date.now();
    expect(await readPreview(`${base}/hang`, { ...options, timeoutMs: 300 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(await readPreview(`${base}/json`, options)).toBeNull();
    expect(await readPreview(`${base}/huge`, { ...options, maxBytes: 200_000 })).toEqual({
      title: 'Big',
      site: null,
      image: null,
    });
  });
});
