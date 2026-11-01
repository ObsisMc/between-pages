import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';

// Reads a wish's link once for its preview (wishes-and-gifts D7): the page's title, site
// name and image address, as text. It reaches only public addresses: the address every
// connection is made to is checked when it is resolved, so a name that resolves to an
// internal address, or changes to one between two lookups, is refused, and each redirect
// is checked again. It sends no cookie, runs no script and stores nothing.

export type Preview = { title: string | null; site: string | null; image: string | null };

export type ReadOptions = {
  /** Addresses never connected to; tests narrow it to reach a local server. */
  blocked?: BlockList;
  resolve?: typeof dnsLookup;
  timeoutMs?: number;
  maxBytes?: number;
};

const MAX_REDIRECTS = 3;
const TITLE_MAX = 200;
const SITE_MAX = 100;
const IMAGE_MAX = 2000;

/** Loopback, private, link-local (cloud metadata included), multicast and reserved ranges. */
export function publicOnly(): BlockList {
  const list = new BlockList();
  for (const [net, prefix] of [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ] as const)
    list.addSubnet(net, prefix, 'ipv4');
  for (const [net, prefix] of [
    ['::', 128],
    ['::1', 128],
    ['64:ff9b::', 96],
    ['fc00::', 7],
    ['fe80::', 10],
    ['ff00::', 8],
  ] as const)
    list.addSubnet(net, prefix, 'ipv6');
  return list;
}

function isBlocked(blocked: BlockList, address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return blocked.check(mapped[1]!, 'ipv4');
  const family = isIP(address);
  if (family === 0) return true;
  return blocked.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

type Fetched = { location: string | null; contentType: string; body: Buffer };

function fetchOnce(
  url: URL,
  signal: AbortSignal,
  options: Required<ReadOptions>,
): Promise<Fetched> {
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  // A literal address is connected to without a lookup, so it is checked here.
  if (isIP(host) && isBlocked(options.blocked, host))
    return Promise.reject(new Error('address not allowed'));
  const lookup = (
    hostname: string,
    opts: { all?: boolean },
    callback: (error: Error | null, address: string | LookupAddress[], family?: number) => void,
  ) =>
    options.resolve(hostname, { all: true }, (error, addresses) => {
      if (error) return callback(error, '');
      if (!addresses.length || addresses.some((a) => isBlocked(options.blocked, a.address)))
        return callback(new Error('address not allowed'), '');
      if (opts.all) return callback(null, addresses);
      callback(null, addresses[0]!.address, addresses[0]!.family);
    });
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      method: 'GET',
      agent: false,
      signal,
      lookup: lookup as never,
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'user-agent': 'BetweenPages-LinkPreview/1',
      },
    });
    request.on('error', reject);
    request.on('response', (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.destroy();
        return resolve({
          location: response.headers.location,
          contentType: '',
          body: Buffer.alloc(0),
        });
      }
      const chunks: Buffer[] = [];
      let size = 0;
      const done = () => {
        response.destroy();
        resolve({
          location: null,
          contentType:
            status >= 200 && status < 300 ? String(response.headers['content-type'] ?? '') : '',
          body: Buffer.concat(chunks).subarray(0, options.maxBytes),
        });
      };
      response.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        size += chunk.length;
        // Only <head> is needed; stop once it is closed or the cap is reached.
        if (size >= options.maxBytes || /<\/head\s*>/i.test(chunk.toString('latin1'))) done();
      });
      response.on('end', done);
      response.on('error', reject);
    });
    request.end();
  });
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code =
        name[1] === 'x' || name[1] === 'X'
          ? parseInt(name.slice(2), 16)
          : parseInt(name.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

const clean = (text: string | undefined, max: number): string | null => {
  const value = text && decodeEntities(text).replace(/\s+/g, ' ').trim();
  return value ? value.slice(0, max) : null;
};

function decode(body: Buffer, contentType: string): string {
  const declared =
    /charset=["']?([\w-]+)/i.exec(contentType)?.[1] ??
    /<meta[^>]+charset=["']?([\w-]+)/i.exec(body.toString('latin1'))?.[1];
  try {
    return new TextDecoder(declared ?? 'utf-8').decode(body);
  } catch {
    return new TextDecoder('utf-8').decode(body);
  }
}

/** Open Graph first, then `<title>`; the image only as an absolute https address. */
export function parseHead(html: string, pageUrl: URL): Preview {
  const head = html.split(/<\/head\s*>/i)[0]!;
  const meta = new Map<string, string>();
  for (const tag of head.match(/<meta\b[^>]*>/gi) ?? []) {
    const attrs = new Map<string, string>();
    for (const [, name, , dq, sq, bare] of tag.matchAll(
      /([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g,
    ))
      attrs.set(name!.toLowerCase(), dq ?? sq ?? bare ?? '');
    const key = (attrs.get('property') ?? attrs.get('name'))?.toLowerCase();
    const content = attrs.get('content');
    if (key && content !== undefined && !meta.has(key)) meta.set(key, content);
  }
  const title =
    meta.get('og:title') ??
    meta.get('twitter:title') ??
    /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1];
  const rawImage =
    meta.get('og:image') ?? meta.get('og:image:secure_url') ?? meta.get('twitter:image');
  let image: string | null = null;
  if (rawImage) {
    try {
      const resolved = new URL(decodeEntities(rawImage.trim()), pageUrl);
      if (resolved.protocol === 'https:' && resolved.href.length <= IMAGE_MAX)
        image = resolved.href;
    } catch {
      image = null;
    }
  }
  return { title: clean(title, TITLE_MAX), site: clean(meta.get('og:site_name'), SITE_MAX), image };
}

/**
 * The preview of `link`, or null when it cannot be read: not http(s), an address that is
 * not public, more than three redirects, no HTML, a timeout (5 s for the whole read) or any
 * network failure. Reads at most 1 MB.
 */
export async function readPreview(
  link: string,
  options: ReadOptions = {},
): Promise<Preview | null> {
  const settings: Required<ReadOptions> = {
    blocked: options.blocked ?? publicOnly(),
    resolve: options.resolve ?? dnsLookup,
    timeoutMs: options.timeoutMs ?? 5_000,
    maxBytes: options.maxBytes ?? 1_000_000,
  };
  const signal = AbortSignal.timeout(settings.timeoutMs);
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
      const fetched = await fetchOnce(url, signal, settings);
      if (fetched.location === null) {
        if (!/^(text\/html|application\/xhtml\+xml)/i.test(fetched.contentType)) return null;
        return parseHead(decode(fetched.body, fetched.contentType), url);
      }
      url = new URL(fetched.location, url);
    }
    return null;
  } catch {
    return null;
  }
}
