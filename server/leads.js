import { DAY, now, nowIso } from './clock.js';
import { LOST, T } from './copy.js';
import { reminderDue } from './outreach.js';

// The two lists and what the admin does to a lead by hand. As in openfrequency-accounts' /admin/leads (the owner
// there, 2026-11-12: "those that were already reached to, move them to a different page"): the leads we have not
// written to are one list, by score; the ones we wrote to, and the ones who wrote to us, are another, with where each
// stands and the funnel of all of them in one line.

export const getLead = (db, id) => db.get('SELECT * FROM leads WHERE id = ?', id);

/** The search box's words, as a WHERE: the name, the site, the city or the number (0541234567 or 541234567). */
function searchOf(q) {
  const t = String(q || '').trim();
  if (!t) return { sql: '', params: [] };
  const digits = t.replace(/\D/g, '').replace(/^0/, '');
  const like = `%${t.toLowerCase()}%`;
  if (digits.length >= 4) return { sql: ' AND (lower(name) LIKE ? OR lower(coalesce(domain, \'\')) LIKE ? OR coalesce(city, \'\') LIKE ? OR coalesce(mobile, \'\') LIKE ?)', params: [like, like, like, `%${digits}%`] };
  return { sql: ' AND (lower(name) LIKE ? OR lower(coalesce(domain, \'\')) LIKE ? OR coalesce(city, \'\') LIKE ?)', params: [like, like, like] };
}

const NEW_TABS = { fit: ' AND qualified = 1', below: ' AND qualified = 0', all: '' };

export function listNew(db, { tab = 'fit', q = '', limit = 200 } = {}) {
  const s = searchOf(q);
  return db.all(`SELECT * FROM leads WHERE stage = 'new'${NEW_TABS[tab] ?? NEW_TABS.fit}${s.sql} ORDER BY qualified DESC, score DESC, id DESC LIMIT ?`, ...s.params, limit);
}

export function countsNew(db, q = '') {
  const s = searchOf(q);
  const r = db.get(`SELECT count(*) AS all_, sum(qualified = 1) AS fit, sum(qualified = 0) AS below FROM leads WHERE stage = 'new'${s.sql}`, ...s.params);
  return { all: r.all_ || 0, fit: r.fit || 0, below: r.below || 0 };
}

export const REACHED_TABS = ['waiting', 'talking', 'closed'];

/** The ones we wrote to: in a conversation first (newest message first), then waiting (due first), then closed. */
export function listReached(db, { tab = '', q = '', at = now(), limit = 300 } = {}) {
  const s = searchOf(q);
  const where = REACHED_TABS.includes(tab) ? ` AND stage = '${tab}'` : " AND stage != 'new'";
  const rows = db.all(`SELECT * FROM leads WHERE 1 = 1${where}${s.sql} ORDER BY coalesce(last_in_at, reminder_at, first_at, updated_at) DESC LIMIT ?`, ...s.params, limit);
  const rank = (x) => (x.stage === 'talking' ? 0 : x.stage === 'waiting' ? (reminderDue(x, at) || laterDue(x, at) ? 1 : 2) : 3);
  return rows.sort((a, b) => rank(a) - rank(b));
}

export function countsReached(db, q = '') {
  const s = searchOf(q);
  const r = db.get(`SELECT count(*) AS all_, sum(stage = 'waiting') AS waiting, sum(stage = 'talking') AS talking, sum(stage = 'closed') AS closed FROM leads WHERE stage != 'new'${s.sql}`, ...s.params);
  return { all: r.all_ || 0, waiting: r.waiting || 0, talking: r.talking || 0, closed: r.closed || 0 };
}

/** Everyone we wrote to, in one line: sent, delivered, read, said yes, answered, then the ones it never reached. */
export function funnel(db) {
  const r = db.get(`SELECT
      sum(first_at IS NOT NULL) AS sent,
      sum(out_state IN ('delivered', 'read', 'yes', 'replied') OR (out_state = 'stopped' AND first_at IS NOT NULL)) AS delivered,
      sum(out_state IN ('read', 'yes', 'replied')) AS read,
      sum(yes_at IS NOT NULL) AS yes,
      sum(replied_at IS NOT NULL AND first_at IS NOT NULL) AS replied,
      sum(out_state IN ('failed', 'undelivered')) AS undelivered,
      sum(out_state = 'stopped' AND first_at IS NOT NULL) AS stopped,
      sum(closed_why = 'customer') AS customer
    FROM leads WHERE source != 'whatsapp' OR first_at IS NOT NULL`);
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v || 0]));
}

export const laterDue = (x, at = now()) => Boolean(x.later_until && Date.parse(x.later_until) <= at && x.stage !== 'closed');

export const messagesOf = (db, leadId) => db.all('SELECT * FROM messages WHERE lead_id = ? ORDER BY at, id', leadId);
export const lastIn = (db, leadId) => db.get("SELECT * FROM messages WHERE lead_id = ? AND dir = 'in' ORDER BY at DESC, id DESC LIMIT 1", leadId);

// ---- What the admin does to a lead by hand. Each answers the line the page says after it.

const touch = (db, id, sets, ...params) => db.run(`UPDATE leads SET ${sets}, updated_at = ? WHERE id = ?`, ...params, nowIso(), id);

export function markReplied(db, lead) {
  touch(db, lead.id, "replied_at = coalesce(replied_at, ?), stage = 'talking', closed_why = NULL, out_state = CASE WHEN out_state = 'stopped' THEN out_state ELSE 'replied' END", nowIso());
  return T.stands.done.replied;
}

export function markCustomer(db, lead) {
  touch(db, lead.id, "stage = 'closed', closed_why = 'customer', later_until = NULL");
  return T.stands.done.customer;
}

export function later(db, lead, days, whenHe) {
  const d = [1, 7].includes(Number(days)) ? Number(days) : 1;
  const until = now() + d * DAY;
  touch(db, lead.id, `later_until = ?${lead.stage === 'new' ? ", stage = 'talking'" : ''}`, nowIso(until));
  return T.stands.done.later(whenHe(until));
}

export function lose(db, lead, reason) {
  const why = Object.hasOwn(LOST, reason) ? reason : 'other';
  touch(db, lead.id, "stage = 'closed', closed_why = ?, later_until = NULL", why);
  return T.stands.done.lost;
}

export function skip(db, lead) {
  touch(db, lead.id, "stage = 'closed', closed_why = 'skipped', later_until = NULL");
  return T.stands.done.skip;
}

/** Back on a list: the leads one if we never wrote to them, else the conversation or the wait it was in. */
export function reopen(db, lead) {
  const stage = lead.replied_at || lead.yes_at || lead.source === 'whatsapp' ? 'talking' : lead.first_at ? 'waiting' : 'new';
  touch(db, lead.id, 'stage = ?, closed_why = NULL', stage);
  return T.stands.done.reopen;
}

export function saveNotes(db, lead, notes) {
  touch(db, lead.id, 'notes = ?', String(notes || '').slice(0, 4000));
  return T.stands.done.notes;
}

export function saveName(db, lead, name) {
  const n = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  touch(db, lead.id, 'msg_name = ?', n || null);
  return T.stands.done.name;
}

/** Deleted with its messages; its site stays in `seen`, so a search never adds it again. */
export function removeLead(db, lead) {
  db.tx(() => {
    if (lead.domain) db.run("INSERT INTO seen (domain, status, reason, at) VALUES (?, 'deleted', NULL, ?) ON CONFLICT (domain) DO UPDATE SET status = 'deleted', at = excluded.at", lead.domain, nowIso());
    db.run('DELETE FROM leads WHERE id = ?', lead.id);
  });
  return T.end.done;
}

/**
 * Keeping leads (the privacy policy, privacy.html#p-keep): a lead that is not a customer is deleted LEAD_KEEP_MONTHS
 * (6) after anything last happened with it: a message either way, a status, or a change by the admin. Its site stays
 * in `seen` and a number that asked us to stop stays in `stops`, so a search never adds it again and no one writes to
 * it again. The same six months as openfrequency-web's leads (site.config.json legal.leadMonths).
 */
export function purgeLeads(db, months = 6, at = now()) {
  const before = nowIso(at - months * 30 * DAY);
  const rows = db.all("SELECT id, domain FROM leads WHERE updated_at < ? AND coalesce(closed_why, '') != 'customer'", before);
  db.tx(() => {
    for (const r of rows) {
      if (r.domain) db.run("INSERT INTO seen (domain, status, reason, at) VALUES (?, 'expired', NULL, ?) ON CONFLICT (domain) DO UPDATE SET status = 'expired', at = excluded.at", r.domain, nowIso(at));
      db.run('DELETE FROM leads WHERE id = ?', r.id);
    }
  });
  return rows.length;
}

/**
 * They asked us, by mail or on the phone, not to write to them: the number joins `stops`, as a "לא, תודה" on WhatsApp
 * does (outreach.js), and every lead with it closes. The privacy policy promises it (privacy.html#p-outreach).
 */
export function stopLead(db, lead) {
  const at = nowIso();
  db.tx(() => {
    if (lead.mobile) db.run('INSERT OR IGNORE INTO stops (phone, why, at) VALUES (?, ?, ?)', lead.mobile, 'ביקשו מאיתנו ישירות', at);
    db.run("UPDATE leads SET stage = 'closed', closed_why = 'stopped', out_state = 'stopped', later_until = NULL, updated_at = ? WHERE id = ? OR (mobile IS NOT NULL AND mobile = ?)", at, lead.id, lead.mobile);
  });
  return T.stands.done.stop;
}
