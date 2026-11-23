import { HOUR, israelDate, now, nowIso } from './clock.js';

// Writing to a customer from the business number (pay.js, setup.js): whether plain text may go, and keeping what went in
// `messages`, in the chat of their lead, where the admin's inbox shows it.

/**
 * Whether we may write to this number in plain text: within 24 hours of its last message to the business number, as
 * a lead's or as anything else kept there (the owner's own "בדיקה", 2026-11-23, came in as theirs and opened nothing).
 */
export function windowOpen(db, phone, at = now()) {
  const last = db.get("SELECT max(t) AS t FROM (SELECT max(last_in_at) AS t FROM leads WHERE mobile = ? UNION ALL SELECT max(at) FROM messages WHERE phone = ? AND dir = 'in')", phone, phone)?.t;
  return Boolean(last && at - Date.parse(last) < 24 * HOUR - 5 * 60_000);
}

const leadOf = (db, c) => db.get('SELECT id FROM leads WHERE id = ?', c.lead_id ?? -1)?.id ?? db.get('SELECT id FROM leads WHERE mobile = ? ORDER BY id DESC LIMIT 1', c.phone)?.id ?? null;

/** Keep a message that went (or failed) to customer c. */
export function keep(db, c, { kind, body, waId = null, status, error = null }) {
  db.run('INSERT INTO messages (lead_id, phone, dir, kind, body, wa_id, status, error, day, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', leadOf(db, c), c.phone, 'out', kind, body, waId, status, error, israelDate(), nowIso());
}
