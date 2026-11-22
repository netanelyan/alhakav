import { alertOwner, ownerNumber } from './alerts.js';
import { DAY, israelDate, israelParts, now, nowIso } from './clock.js';
import { DIGEST } from './copy.js';

// The day's summary, on the owner's WhatsApp once an evening (alerts.js): what the last 24 hours brought, from finding
// tradespeople to a payment approved. Sent from DIGEST_HOUR (19) Israel time, once a date, and only when something
// happened.

/** What happened in the 24 hours before `at`, as counts. */
export function dayCounts(db, env, at = now()) {
  const since = nowIso(at - DAY);
  const owner = ownerNumber(env) || '-';
  const n = (sql, ...p) => db.get(sql, ...p).n;
  return {
    found: n("SELECT count(*) AS n FROM leads WHERE qualified = 1 AND source != 'whatsapp' AND created_at > ?", since),
    sent: n("SELECT count(*) AS n FROM messages WHERE dir = 'out' AND kind = 'first' AND coalesce(status, '') != 'failed' AND at > ?", since),
    reminded: n("SELECT count(*) AS n FROM messages WHERE dir = 'out' AND kind = 'reminder' AND coalesce(status, '') != 'failed' AND at > ?", since),
    pages: n('SELECT count(*) AS n FROM leads WHERE page_last_at > ?', since),
    tried: n('SELECT count(DISTINCT lead_id) AS n FROM demos WHERE started_at > ?', since),
    answered: n("SELECT count(DISTINCT m.phone) AS n FROM messages m JOIN leads l ON l.id = m.lead_id WHERE m.dir = 'in' AND m.kind = 'in' AND m.at > ? AND m.phone != ? AND l.first_at IS NOT NULL", since, owner),
    wrote: n("SELECT count(*) AS n FROM leads WHERE source = 'whatsapp' AND created_at > ? AND mobile != ?", since, owner),
    joined: n('SELECT count(*) AS n FROM customers WHERE created_at > ?', since),
    paid: n("SELECT count(*) AS n FROM receipts WHERE decision = 'paid' AND decided_at > ?", since),
    stopped: n('SELECT count(*) AS n FROM stops WHERE at > ?', since),
  };
}

/** Once an evening, the summary goes; answers whether one went now. */
export async function digestTick(app, at = now()) {
  const hour = Number(app.env.DIGEST_HOUR ?? 19);
  if (!(hour >= 0 && hour < 24) || israelParts(at).hour < hour) return false;
  const key = `digest:${israelDate(at)}`;
  if (app.db.kv(key)) return false;
  app.db.kv(key, nowIso(at));
  const text = DIGEST.text(dayCounts(app.db, app.env, at));
  if (!text) return false;
  return alertOwner(app, key, DIGEST.title, `${text}\n${DIGEST.link(`${String(app.env.SITE_URL || '').replace(/\/+$/, '')}/admin/inbox`)}`, 24 * 60);
}
