import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

// Reading a tradesperson's site. A search result or an address typed on the admin page could point anywhere, this
// machine and its network included, so: http and https only, on their own ports, to public addresses only (checked
// again on every redirect), a few redirects, a size cap and a timeout. The page is decoded by its own charset, since
// older Israeli sites are still in windows-1255.

/** Is this an address on this machine or a private network? Anything that is not an IP counts as one. */
export function privateAddress(ip) {
  const a = String(ip || '').toLowerCase();
  if (a.startsWith('::ffff:')) return privateAddress(a.slice(7));
  if (isIP(a) === 4) {
    const [x, y] = a.split('.').map(Number);
    return x === 0 || x === 10 || x === 127 || x >= 224 || (x === 169 && y === 254) || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 100 && y >= 64 && y <= 127);
  }
  if (isIP(a) === 6) return a === '::' || a === '::1' || /^f[cd]/.test(a) || /^fe[89ab]/.test(a);
  return true;
}

const fail = (code, message = code) => Object.assign(new Error(message), { code });

function charsetOf(type, head) {
  const fromHeader = /charset\s*=\s*["']?([\w-]+)/i.exec(type || '')?.[1];
  const fromMeta = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1];
  return (fromHeader || fromMeta || 'utf-8').toLowerCase();
}

async function readCapped(res, max) {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    chunks.push(value);
    if (size >= max) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return Buffer.concat(chunks);
}

export function makeFetcher({ fetchImpl = fetch, resolve = (host) => lookup(host, { all: true }), timeoutMs = 12_000, maxBytes = 1_500_000, maxRedirects = 5, allowPrivate = false, userAgent = 'Mozilla/5.0 (compatible; AlHakavBot/1.0)' } = {}) {
  async function check(u) {
    if (!['http:', 'https:'].includes(u.protocol)) throw fail('bad_scheme', 'only http and https');
    if (allowPrivate) return;
    if (u.port && !['80', '443'].includes(u.port)) throw fail('bad_port', 'only the standard ports');
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const addrs = isIP(host) ? [{ address: host }] : await resolve(host);
    if (!addrs.length || addrs.some((a) => privateAddress(a.address))) throw fail('private_address', 'the address is not on the public internet');
  }

  return async function fetchPage(url) {
    let u = new URL(url);
    for (let hop = 0; hop <= maxRedirects; hop++) {
      await check(u);
      const res = await fetchImpl(u, {
        redirect: 'manual',
        headers: { 'user-agent': userAgent, accept: 'text/html,application/xhtml+xml', 'accept-language': 'he,en;q=0.5' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const to = res.headers.get('location');
        await res.body?.cancel().catch(() => {});
        if (!to) throw fail('bad_redirect', 'a redirect with nowhere to go');
        u = new URL(to, u);
        continue;
      }
      const type = res.headers.get('content-type') || '';
      if (type && !/html|xml|text\/plain/i.test(type)) {
        await res.body?.cancel().catch(() => {});
        throw fail('not_html', `not a web page (${type.split(';')[0]})`);
      }
      const bytes = await readCapped(res, maxBytes);
      let text;
      try {
        text = new TextDecoder(charsetOf(type, bytes.subarray(0, 2048).toString('latin1'))).decode(bytes);
      } catch {
        text = new TextDecoder('utf-8').decode(bytes);
      }
      return { url: u.href, status: res.status, text };
    }
    throw fail('too_many_redirects', 'too many redirects');
  };
}
