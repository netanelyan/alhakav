import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { DAY, MINUTE, now, nowIso } from './clock.js';

// One admin, one password. The password is kept only as a scrypt hash in private/.env (ADMIN_PASSWORD_HASH, made by
// `npm run admin:password`); a signed-in browser holds a random session id whose SHA-256 alone is in the database; every
// form carries a CSRF token signed from the session. Ported from openfrequency-accounts' src/auth/*.

const PARAMS = { N: 16384, r: 8, p: 1 };
export const MIN_PASSWORD = 12;

export function hashPassword(password, salt = randomBytes(16)) {
  const key = scryptSync(String(password), salt, 32, PARAMS);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

export function checkPassword(password, stored) {
  const m = /^scrypt\$([0-9a-f]+)\$([0-9a-f]+)$/.exec(String(stored || ''));
  if (!m) return false;
  const want = Buffer.from(m[2], 'hex');
  const got = scryptSync(String(password), Buffer.from(m[1], 'hex'), want.length, PARAMS);
  return timingSafeEqual(want, got);
}

export const newToken = () => randomBytes(32).toString('base64url');
export const hashToken = (token) => createHash('sha256').update(String(token)).digest('hex');
export const looksLikeToken = (value) => /^[A-Za-z0-9_-]{43}$/.test(String(value || ''));

/** 30 days at most, and 14 without a visit end it sooner (accounts' superadmin, since 2026-11-11). */
export const SESSION = { idleMs: 14 * DAY, maxMs: 30 * DAY };

export function startSession(db, ip) {
  const token = newToken();
  db.run('INSERT INTO sessions (id_hash, created_at, seen_at, ip) VALUES (?, ?, ?, ?)', hashToken(token), nowIso(), nowIso(), String(ip || '').slice(0, 64));
  return token;
}

export function sessionOf(db, token) {
  if (!looksLikeToken(token)) return null;
  const row = db.get('SELECT * FROM sessions WHERE id_hash = ?', hashToken(token));
  if (!row) return null;
  const t = now();
  if (t - Date.parse(row.created_at) > SESSION.maxMs || t - Date.parse(row.seen_at) > SESSION.idleMs) {
    db.run('DELETE FROM sessions WHERE id_hash = ?', row.id_hash);
    return null;
  }
  if (t - Date.parse(row.seen_at) > MINUTE) db.run('UPDATE sessions SET seen_at = ? WHERE id_hash = ?', nowIso(), row.id_hash);
  return row;
}

export function endSession(db, token) {
  if (looksLikeToken(token)) db.run('DELETE FROM sessions WHERE id_hash = ?', hashToken(token));
}

export function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

const fromProxy = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress);

/** Did this request reach us over HTTPS? Only the proxy on this machine may say so. */
export const isHttps = (req) => fromProxy(req) && String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https';

export function clientIp(req) {
  if (fromProxy(req)) {
    const f = String(req.headers['x-forwarded-for'] || '').split(',').pop().trim();
    if (f) return f;
  }
  return req.socket?.remoteAddress || 'unknown';
}

/** SESSION_SECRET, or one for this process only: forms do not survive a restart, the safe failure for a missing one. */
export function sessionSecret(env) {
  const s = String(env.SESSION_SECRET || '').trim();
  if (s.length >= 32) return s;
  globalThis.__alhakavSecret ??= randomBytes(32).toString('hex');
  return globalThis.__alhakavSecret;
}

export const csrfFor = (token, secret) => createHmac('sha256', secret).update(`csrf:${token}`).digest('base64url').slice(0, 32);

export function csrfOk(given, token, secret) {
  if (!token) return false;
  const want = Buffer.from(csrfFor(token, secret));
  const got = Buffer.from(String(given || ''));
  return want.length === got.length && timingSafeEqual(want, got);
}

/** At most `max` tries per key in `windowMs`: the sign-in, by address. */
export function limiter({ max = 5, windowMs = 15 * MINUTE } = {}) {
  const hits = new Map();
  return {
    allow(key) {
      const t = now();
      const h = (hits.get(key) || []).filter((x) => t - x < windowMs);
      const ok = h.length < max;
      if (ok) h.push(t);
      hits.set(key, h);
      if (hits.size > 10_000) hits.delete(hits.keys().next().value);
      return ok;
    },
    clear(key) {
      hits.delete(key);
    },
  };
}
