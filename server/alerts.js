import { num } from './env.js';
import { local } from './phones.js';

// The admin's alerts on their own WhatsApp: a new person wrote, someone wants to join, Toran passed someone on, a
// transfer's picture came. They go through openfrequency-toran, which already sends its own and Teder's to the owner's
// phone (its POST /internal/ops/alert, src/ops/alertRoute.ts): one approved template from OpenFrequency's number, its
// own limits (a key once in its window, at most ten an hour over every product), so the business number never writes
// to the admin and needs no template of its own. Toran runs on the same machine; the call never leaves it.
//
//   TORAN_URL            Toran's local address, http://127.0.0.1:4710 by default
//   OF_INTERNAL_TOKEN    the token Toran checks (the same one in its private/.env)
//
// Without the token an alert is only a log line. Never throws.

export function toranBase(env) {
  return { url: String(env.TORAN_URL || 'http://127.0.0.1:4710').replace(/\/+$/, ''), token: String(env.OF_INTERNAL_TOKEN || '').trim() };
}

/** Where the admin sees it: a page on the site, from SITE_URL. */
export const adminLink = (env, p) => `${String(env.SITE_URL || '').replace(/\/+$/, '')}${p}`;

/** Who someone is in an alert: their name and their number as Israelis write it. */
export const whoIs = (name, phone) => [String(name || '').trim(), phone ? local(phone) : ''].filter(Boolean).join(', ');

/** One alert: said at most once in everyMinutes for the same key. Answers whether Toran took it. */
export async function alertOwner(app, key, title, body = '', everyMinutes = 60) {
  const t = toranBase(app.env);
  app.log(`[alert] ${key}: ${title}`);
  if (!t.token) return false;
  try {
    const r = await app.toranFetch(`${t.url}/internal/ops/alert`, {
      method: 'POST',
      headers: { authorization: `Bearer ${t.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ product: 'alhakav', key: key.replace(/[^A-Za-z0-9_.:@-]/g, '-').slice(0, 120), title: title.slice(0, 500), body: body.slice(0, 4000), everyMinutes: Math.round(num(everyMinutes, 60)) }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) app.log(`[alert] ${key}: Toran answered ${r.status}`);
    return r.ok;
  } catch (e) {
    app.log(`[alert] ${key}: not sent (${e.message})`);
    return false;
  }
}
