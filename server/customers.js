import { billingOf, dateHe } from './billing.js';
import { DAY, israelDate, now, nowIso } from './clock.js';
import { PAY, TC } from './copy.js';
import { isMobile, local, normalize } from './phones.js';

// The customers, as the admin sets them up and looks after them. A customer starts in "setup": their own number is
// bought at Telnyx (voice only: it takes their forwarded calls and says whose they are) and pasted here, the customer
// dials the forwarding codes, and the assistant is on from the moment the codes go to them (setup.js), or when the admin
// turns it on. On WhatsApp every customer's assistant is המוקדן, the one number all of them share (service.js), so
// nothing is registered for each.

export const getCustomer = (db, id) => db.get('SELECT * FROM customers WHERE id = ?', id);

export function listCustomers(db, at = now()) {
  return db.all(
    "SELECT c.*, (SELECT count(*) FROM calls WHERE customer_id = c.id AND at > ? AND outcome != 'otp') AS calls_week FROM customers c ORDER BY CASE c.status WHEN 'active' THEN 0 WHEN 'setup' THEN 1 WHEN 'paused' THEN 2 ELSE 3 END, c.id DESC",
    nowIso(at - 7 * DAY)
  );
}

const clean = (s, n = 80) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

/** The fields from a form, checked: a name, a business name, and the customer's own mobile. */
function fieldsOf(f) {
  const phone = normalize(f.phone);
  const assistant = f.assistant ? normalize(f.assistant) : null;
  const v = { name: clean(f.name), business: clean(f.business), trade: ['plumber', 'electrician', 'ac', 'locksmith'].includes(f.trade) ? f.trade : null, phone, assistant };
  if (!v.name || !v.business || !isMobile(phone) || (f.assistant && !assistant)) return null;
  return v;
}

export function createCustomer(db, f, leadId = null) {
  const v = fieldsOf(f);
  if (!v) return { ok: false, flash: TC.bad };
  if (v.assistant && db.get('SELECT 1 FROM customers WHERE assistant = ?', v.assistant)) return { ok: false, flash: TC.bad };
  const at = nowIso();
  const id = Number(
    db.run('INSERT INTO customers (lead_id, name, business, trade, phone, assistant, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', leadId, v.name, v.business, v.trade, v.phone, v.assistant, at, at).lastInsertRowid
  );
  return { ok: true, id, flash: TC.created };
}

/** A lead that became a customer: the customer, set up from what the lead page knew. */
export function customerFromLead(db, lead) {
  const have = db.get('SELECT id FROM customers WHERE lead_id = ?', lead.id);
  if (have) return have.id;
  if (!isMobile(lead.mobile)) return null;
  const r = createCustomer(db, { name: lead.name, business: lead.msg_name || lead.name, trade: lead.trade, phone: lead.mobile }, lead.id);
  return r.ok ? r.id : null;
}

export function updateCustomer(db, c, f) {
  const v = fieldsOf(f);
  if (!v) return { ok: false, flash: TC.bad };
  if (v.assistant && v.assistant !== c.assistant && db.get('SELECT 1 FROM customers WHERE assistant = ? AND id != ?', v.assistant, c.id)) return { ok: false, flash: TC.bad };
  const moved = v.assistant !== c.assistant;
  db.run(
    `UPDATE customers SET name = ?, business = ?, trade = ?, phone = ?, assistant = ?, updated_at = ? WHERE id = ?`,
    v.name,
    v.business,
    v.trade,
    v.phone,
    v.assistant,
    nowIso(),
    c.id
  );
  return { ok: true, flash: TC.saved };
}

export function setStatus(db, c, status) {
  const to = { activate: 'active', pause: 'paused', stop: 'stopped' }[status];
  if (!to) return { ok: false, flash: '?' };
  // Turned on again after it stopped: a stop at the month's end that already passed is over too.
  db.run(`UPDATE customers SET status = ?, stopped_at = ${to === 'stopped' ? '?' : 'NULL'}${to === 'active' && c.status === 'stopped' ? ', ends_on = NULL' : ''}, updated_at = ? WHERE id = ?`, ...[to, ...(to === 'stopped' ? [nowIso()] : []), nowIso(), c.id]);
  return { ok: true, flash: { active: TC.steps.activated, paused: TC.steps.paused, stopped: TC.steps.stopped }[to] };
}

export const skipsOf = (db, id) => db.all('SELECT * FROM skips WHERE customer_id = ? ORDER BY at DESC', id);

export function addSkip(db, c, raw) {
  const phone = normalize(raw);
  if (!phone) return { ok: false, flash: TC.bad };
  db.run("INSERT INTO skips (customer_id, phone, why, at) VALUES (?, ?, 'admin', ?) ON CONFLICT (customer_id, phone) DO NOTHING", c.id, phone, nowIso());
  return { ok: true, flash: TC.saved };
}

export function removeSkip(db, c, raw) {
  db.run('DELETE FROM skips WHERE customer_id = ? AND phone = ?', c.id, normalize(raw) || String(raw || ''));
  return { ok: true, flash: TC.saved };
}

/** The last conversations, newest first, each with its messages. */
export function recentChats(db, id, limit = 20) {
  const chats = db.all('SELECT * FROM chats WHERE customer_id = ? ORDER BY opened_at DESC, id DESC LIMIT ?', id, limit);
  return chats.map((x) => ({ ...x, messages: db.all('SELECT * FROM chat_messages WHERE chat_id = ? ORDER BY at, id', x.id) }));
}

export const recentCalls = (db, id, limit = 10) => db.all('SELECT * FROM calls WHERE customer_id = ? ORDER BY at DESC, id DESC LIMIT ?', id, limit);

/** The four codes the customer dials, with their assistant's number in them, local form. */
export function forwardCodes(assistant) {
  const n = local(assistant).replace(/-/g, '');
  return [`**61*${n}**20#`, `**67*${n}#`, `**62*${n}#`, '*#61#'];
}

/** The invoice's details and the price (docs/payments.md). */
export function updateBilling(db, c, f) {
  const price = Number(String(f.price ?? '').replace(/[^\d.]/g, ''));
  const email = clean(f.email, 120);
  if (!(price >= 0 && price <= 100000) || String(f.price ?? '').trim() === '' || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return { ok: false, flash: PAY.admin.billingBad };
  db.run(
    'UPDATE customers SET price = ?, free = ?, invoice_name = ?, tax_id = ?, address = ?, email = ?, updated_at = ? WHERE id = ?',
    Math.round(price * 100) / 100,
    f.free ? 1 : 0,
    clean(f.invoice_name) || null,
    clean(f.tax_id, 20) || null,
    clean(f.address, 120) || null,
    email || null,
    nowIso(),
    c.id
  );
  return { ok: true, flash: TC.saved };
}

/** "להפסיק בסוף החודש ששולם": the assistant works to the end of the paid month, then stops (pay.js payTick). */
export function endAtMonthEnd(db, c) {
  const b = billingOf(c);
  const last = b.paidUntil && b.paidUntil >= israelDate() ? b.paidUntil : israelDate();
  db.run('UPDATE customers SET ends_on = ?, updated_at = ? WHERE id = ?', last, nowIso(), c.id);
  return { ok: true, flash: PAY.admin.ended(dateHe(last)) };
}

export function unend(db, c) {
  db.run('UPDATE customers SET ends_on = NULL, updated_at = ? WHERE id = ?', nowIso(), c.id);
  return { ok: true, flash: PAY.admin.unended };
}

/** The customer and everything of theirs, but the payment records, which the tax law keeps for 7 years. */
export function removeCustomer(db, c) {
  db.tx(() => {
    db.run('UPDATE receipts SET file = NULL WHERE customer_id = ?', c.id);
    db.run('DELETE FROM customers WHERE id = ?', c.id);
  });
  return TC.end.done;
}
