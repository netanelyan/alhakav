import { DAY, HOUR, israelDate, now, nowIso } from './clock.js';
import { num } from './env.js';
import { GraphError, metaSettings, pickTemplate, sendTemplate, sendText } from './meta.js';
import { isMobile, local, masked, normalize } from './phones.js';

// The admin's alerts on their own WhatsApp: a new person wrote, a lead answered, someone wants to join, Toran passed
// someone on, a transfer's picture came, and the day's summary in the evening.
//
// With OWNER_WA set (the owner's own number, in any spelling), they go from the business number straight to it, and
// are kept with its messages (kind 'alert', no lead), so the inbox shows them:
//
//   - plain text while the owner wrote to the business number in the last 24 hours, with the links in it
//   - otherwise an approved template (updateTemplates, docs/whatsapp-templates.md), what happened and its details,
//     with a button to the admin page the alert is about
//
// Each key is said at most once in its everyMinutes (kept in the database, so a restart does not repeat one), and at
// most ALERTS_HOURLY (20) go in an hour. The owner, 2026-11-22: "make the bot update me about sells leads etc, to my
// personal phone number". Until 2026-11-22 they went only through openfrequency-toran's operator_alert, a Marketing
// template from OpenFrequency's number, and Meta held every one of them (131049, its cap on marketing messages to one
// person).
//
// Without OWNER_WA, or when the business number cannot send (not set up, the template not approved yet, Meta refused),
// the alert goes the old way: openfrequency-toran's POST /internal/ops/alert, which sends its own and Teder's to the
// owner's phone. Toran runs on the same machine; the call never leaves it.
//
//   TORAN_URL            Toran's local address, http://127.0.0.1:4710 by default
//   OF_INTERNAL_TOKEN    the token Toran checks (the same one in its private/.env)
//
// Without either, an alert is only a log line. Never throws.

export function toranBase(env) {
  return { url: String(env.TORAN_URL || 'http://127.0.0.1:4710').replace(/\/+$/, ''), token: String(env.OF_INTERNAL_TOKEN || '').trim() };
}

/** Where the admin sees it: a page on the site, from SITE_URL. */
export const adminLink = (env, p) => `${String(env.SITE_URL || '').replace(/\/+$/, '')}${p}`;

/** Who someone is in an alert: their name and their number as Israelis write it. */
export const whoIs = (name, phone) => [String(name || '').trim(), phone ? local(phone) : ''].filter(Boolean).join(', ');

/** The owner's mobile in international digits (0500000123 and +972 50-000-0123 alike), or ''. */
export function ownerNumber(env) {
  const n = normalize(env.OWNER_WA);
  return isMobile(n) ? n : '';
}

/**
 * The templates an alert may go as, the preferred first (meta.js pickTemplate): alhakav_owner_alert, "מה קרה: {{1}}"
 * and "פרטים: {{2}}", reworded on 2026-11-22 after Meta made alhakav_update ("{{1}}" alone) a Marketing one; and
 * alhakav_owner_alert_v2 before both, the same in the look of every message (copy.js).
 * TEMPLATE_UPDATE names one, and only that one is used.
 */
export const updateTemplates = (env) => (String(env.TEMPLATE_UPDATE || '').trim() ? [String(env.TEMPLATE_UPDATE).trim()] : ['alhakav_owner_alert_v2', 'alhakav_owner_alert', 'alhakav_update']);

/** A template's variables: alhakav_update takes the alert in one line, the others what happened and the details. */
export const updateParams = (name, a) => (name === 'alhakav_update' ? [a.param] : [a.head, a.details || 'אין פרטים נוספים.']);

/** The owner wrote to the business number in the last 24 hours: plain text may go. */
export function ownerWindowOpen(db, owner, at = now()) {
  const last = db.get("SELECT max(at) AS at FROM messages WHERE phone = ? AND dir = 'in'", owner)?.at;
  return Boolean(last && Date.parse(last) + DAY > at);
}

const PREFIX = /^על הקו:\s*/;

/**
 * An alert as the business number says it: plain text with its links, or the template's {{1}} (one line, no links:
 * the button opens the page) and the button's end of address (the admin page, "leads" when there is none).
 */
export function alertText(env, title, body) {
  const head = String(title).replace(PREFIX, '').trim();
  const lines = String(body || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const admin = adminLink(env, '/admin/');
  const page = lines.map((l) => l.slice(l.indexOf(admin)).split(/\s/)[0]).find((u) => u.startsWith(admin) && u.length > admin.length);
  const words = lines.filter((l) => !/https?:\/\//.test(l));
  const line = (parts, n) =>
    parts
      .map((l) => l.replace(/[.\s]+$/, ''))
      .join('. ')
      .replace(/\s+/g, ' ')
      .slice(0, n);
  const end = (t) => (!t || /[.?!]$/.test(t) ? t : `${t}.`);
  return { text: [`🔔 *${head}*`, ...lines].join('\n'), param: end(line([head, ...words], 900)), head: line([head], 200), details: end(line(words, 700)), button: page ? page.slice(admin.length) : 'leads' };
}

/** Said within its window already: true. Else marks it said now. */
function seenRecently(db, key, everyMinutes, at) {
  const last = db.kv(`alert:${key}`);
  if (last && Date.parse(last) + everyMinutes * 60_000 > at) return true;
  db.kv(`alert:${key}`, nowIso(at));
  return false;
}

/** From the business number to the owner. Answers whether it went. */
async function toOwner(app, owner, key, title, body) {
  const m = metaSettings(app.env);
  if (!m.ready) return false;
  const at = now();
  const sentHour = app.db.get("SELECT count(*) AS n FROM messages WHERE kind = 'alert' AND phone = ? AND at > ?", owner, nowIso(at - HOUR)).n;
  if (sentHour >= num(app.env.ALERTS_HOURLY, 20)) {
    app.log(`[alert] ${key}: not sent, ${sentHour} alerts went in the last hour`);
    return true; // not for Toran either: it would only add to the pile
  }
  const a = alertText(app.env, title, body);
  const plain = ownerWindowOpen(app.db, owner, at);
  try {
    let id;
    if (plain) id = await sendText(m, app.graphFetch, owner, a.text);
    else {
      const name = await pickTemplate(m, app.graphFetch, updateTemplates(app.env));
      id = await sendTemplate(m, app.graphFetch, owner, name, updateParams(name, a), 'he', { url: a.button });
    }
    app.db.run('INSERT INTO messages (lead_id, phone, dir, kind, body, wa_id, status, day, at) VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?)', owner, 'out', 'alert', a.text, id || null, 'sent', israelDate(at), nowIso(at));
    app.db.run("DELETE FROM messages WHERE kind = 'alert' AND at < ?", nowIso(at - 60 * DAY));
    return true;
  } catch (e) {
    app.log(`[alert] ${key}: the business number could not send it to ${masked(owner)} (${e instanceof GraphError ? `${e.code || e.status} ` : ''}${e.message})`);
    return false;
  }
}

/** Through openfrequency-toran, as before OWNER_WA. Answers whether Toran took it. */
async function throughToran(app, key, title, body, everyMinutes) {
  const t = toranBase(app.env);
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

/** One alert: said at most once in everyMinutes for the same key. Answers whether it went somewhere. */
export async function alertOwner(app, key, title, body = '', everyMinutes = 60) {
  app.log(`[alert] ${key}: ${title}`);
  const owner = ownerNumber(app.env);
  if (owner && metaSettings(app.env).ready) {
    if (seenRecently(app.db, key, num(everyMinutes, 60), now())) return true;
    if (await toOwner(app, owner, key, title, body)) return true;
  }
  return throughToran(app, key, title, body, everyMinutes);
}
