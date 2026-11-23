import { createHash } from 'node:crypto';
import { DAY, HOUR, israelDate, now, nowIso, quiet } from './clock.js';
import { addDays, billingOf, daysBetween, dateHe, money } from './billing.js';
import { adminLink, alertOwner, whoIs } from './alerts.js';
import { ALERT, PAY } from './copy.js';
import { num } from './env.js';
import { GraphError, downloadMedia, metaSettings, sendTemplate, sendText } from './meta.js';
import { invoiceReceipt } from './morning.js';
import { masked } from './phones.js';
import { giveNumber } from './numbers.js';

// Paying (docs/payments.md), as openfrequency pays over WhatsApp, on the business number: the customer gets the
// amount and the transfer details on WhatsApp, transfers, and sends the transfer's picture back to the business number.
// The picture is kept as a receipt with what was owed when it came; the admin checks the bank and presses "התשלום הגיע"
// on /admin/receipts/<id>, which records the month (and Morning issues the invoice-receipt), or "לא הגיע", which records
// nothing. Nothing here records a payment by itself, and nothing moves money: only that press records one.
// "התקבל תשלום" on a customer's page records a month with no picture (a payment that came some other way), kept as a
// receipt already marked paid, so its invoice is issued the same way.
//
//   the picture     an image or a PDF from a customer's own number while something is owed, 5 MB at most, checked by
//                   its first bytes; the very same file again is the same receipt; at most 5 in 24 hours
//   the reminders   from the business number, once each for each paid month, never in a quiet hour (clock.js): two
//                   days before the paid month ends, the day after it ends, the last day of the 72 hours, and once
//                   after the assistant stopped; never to a number that asked us to stop writing (`stops`)
//   the file        deleted 90 days after it came; the receipt's row stays, as the record of the payment
//
// Plain text while the customer wrote to the business number in the last 24 hours, else the approved template
// (TEMPLATE_PAYMENT, docs/whatsapp-templates.md). Nothing here throws to the webhook.

export class PayError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export const RECEIPT_MAX = 5 * 1024 * 1024;
export const RECEIPT_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };
export const RECEIPTS_PER_DAY = 5;
export const RECEIPT_FILE_DAYS = 90;

export function paySettings(env) {
  return { template: String(env.TEMPLATE_PAYMENT || 'alhakav_payment'), details: String(env.PAYMENT_DETAILS || '').replace(/\s+/g, ' ').trim() };
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A file's type by its first bytes: one of RECEIPT_TYPES, or null. */
export function sniff(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG)) return 'image/png';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  return null;
}

const j = (s, fallback = null) => {
  try {
    return s ? JSON.parse(s) : fallback;
  } catch {
    return fallback;
  }
};

const out = (r) => (r ? { ...r, owed: j(r.owed_json), bill: j(r.bill_json), morningError: j(r.morning_error_json) } : null);

/** One receipt, without its file, or null. */
export const receiptById = (db, id) => out(db.get('SELECT id, customer_id, business, source, phone, msg_id, type, size, file IS NOT NULL AS has_file, owed_json, decision, decided_at, bill_json, morning_state, morning_at, morning_error_json, morning_doc_id, morning_number, morning_url, created_at FROM receipts WHERE id = ?', Number(id)));

export const receiptFile = (db, id) => db.get('SELECT type, file FROM receipts WHERE id = ? AND file IS NOT NULL', Number(id));

/** The receipts nobody decided on yet, newest first: the list on /admin/customers. */
export const receiptsWaiting = (db) => db.all('SELECT id, customer_id, business, phone, type, owed_json, created_at FROM receipts WHERE decided_at IS NULL ORDER BY created_at DESC, id DESC').map(out);

export const receiptsOf = (db, customerId, limit = 12) => db.all('SELECT id, source, decision, decided_at, bill_json, owed_json, morning_state, morning_number, morning_url, created_at FROM receipts WHERE customer_id = ? ORDER BY created_at DESC, id DESC LIMIT ?', customerId, limit).map(out);

export const noticesOf = (db, customerId, limit = 8) => db.all('SELECT * FROM pay_notices WHERE customer_id = ? ORDER BY at DESC LIMIT ?', customerId, limit);

/** The customer whose own number this is, the newest first. */
export const customerByPhone = (db, phone) => (phone ? db.get("SELECT * FROM customers WHERE phone = ? ORDER BY status = 'stopped', id DESC LIMIT 1", phone) : null);

// ---- to the customer, from the business number

/** Until when we may write to this number in plain text: 24 hours after its last message to the business number. */
function windowOpen(db, phone, at = now()) {
  const last = db.get('SELECT max(last_in_at) AS t FROM leads WHERE mobile = ?', phone)?.t;
  return Boolean(last && at - Date.parse(last) < 24 * HOUR - 5 * 60_000);
}

const leadOf = (db, c) => db.get('SELECT id FROM leads WHERE id = ?', c.lead_id ?? -1)?.id ?? db.get('SELECT id FROM leads WHERE mobile = ? ORDER BY id DESC LIMIT 1', c.phone)?.id ?? null;

function keep(db, c, { kind, body, waId = null, status, error = null }) {
  const at = nowIso();
  db.run('INSERT INTO messages (lead_id, phone, dir, kind, body, wa_id, status, error, day, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', leadOf(db, c), c.phone, 'out', kind, body, waId, status, error, israelDate(), at);
}

/** Plain text to the customer, inside the 24 hours. Answers whether it went. */
async function tell(app, c, kind, body) {
  const m = metaSettings(app.env);
  if (!m.ready || !windowOpen(app.db, c.phone)) return false;
  try {
    keep(app.db, c, { kind, body, waId: (await sendText(m, app.graphFetch, c.phone, body)) || null, status: 'sent' });
    return true;
  } catch (e) {
    app.log(`[pay] ${kind} to customer ${c.id} not sent: ${e.code || ''} ${e.message}`);
    return false;
  }
}

/** The line that opens the payment message, for where the customer stands. */
export function payLine(c, b) {
  const v = { business: c.business, from: dateHe(b.owed?.from), until: dateHe(b.owed?.until), paidUntil: dateHe(b.paidUntil), graceUntil: dateHe(b.graceUntil), since: dateHe(b.graceUntil ? addDays(b.graceUntil, 1) : null) };
  if (b.state === 'new') return PAY.lines.first(v);
  if (b.state === 'grace') return b.graceUntil === israelDate() ? PAY.lines.last(v) : PAY.lines.due(v);
  if (b.state === 'lapsed') return PAY.lines.stopped(v);
  return PAY.lines.soon(v);
}

/** The payment message as the customer reads it, or null with nothing owed. */
export function payText(env, c, b) {
  if (!b.owed) return null;
  return PAY.message({ line: payLine(c, b), amount: money(b.owed.total), details: paySettings(env).details || PAY.admin.noDetails });
}

/** Why a payment message may not go to this customer now, or null. */
export function payBlocked(app, c, b) {
  if (!metaSettings(app.env).ready) return 'meta';
  if (!paySettings(app.env).details) return 'details';
  if (!b.owed) return 'nothing';
  if (app.db.get('SELECT 1 FROM stops WHERE phone = ?', c.phone)) return 'stopped';
  return null;
}

/**
 * The payment message, now: text inside the 24 hours, else the template. `kind` is what pay_notices keeps it as
 * (ask: the admin's button; soon, due, last, stopped: the reminders). Answers { ok, why? }.
 */
export async function sendPayment(app, c, kind, today = israelDate()) {
  const b = billingOf(c, today);
  const why = payBlocked(app, c, b);
  if (why) return { ok: false, why };
  const s = paySettings(app.env);
  const m = metaSettings(app.env);
  const line = payLine(c, b);
  const body = payText(app.env, c, b);
  const until = b.paidUntil || 'new';
  try {
    const id = windowOpen(app.db, c.phone) ? await sendText(m, app.graphFetch, c.phone, body) : await sendTemplate(m, app.graphFetch, c.phone, s.template, [line, money(b.owed.total), s.details]);
    keep(app.db, c, { kind: 'pay', body, waId: id || null, status: 'sent' });
    app.db.run('INSERT INTO pay_notices (customer_id, until, kind, status, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (customer_id, until, kind) DO UPDATE SET status = excluded.status, at = excluded.at', c.id, until, kind, 'sent', nowIso());
    app.log(`[pay] ${kind} to customer ${c.id}`);
    return { ok: true };
  } catch (e) {
    app.log(`[pay] ${kind} to customer ${c.id} not sent: ${e.code || ''} ${e.message}`);
    keep(app.db, c, { kind: 'pay', body, status: 'failed', error: e.message });
    app.db.run('INSERT INTO pay_notices (customer_id, until, kind, status, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (customer_id, until, kind) DO UPDATE SET status = excluded.status, at = excluded.at', c.id, until, kind, 'failed', nowIso());
    return { ok: false, why: 'failed', detail: e instanceof GraphError ? e.message : String(e.message || e) };
  }
}

// ---- the picture of a transfer

/**
 * An image or a PDF a customer sent to the business number. A receipt while something is owed: kept, and the customer
 * told it came. Answers true when it was taken as one (the caller then leaves the message at that), false otherwise.
 */
export async function takeReceipt(app, c, msg) {
  const { db } = app;
  const b = billingOf(c);
  if (!b.owed || !msg.media) return false;
  if (msg.id && db.get('SELECT 1 FROM receipts WHERE msg_id = ?', msg.id)) return true; // the same webhook again
  const m = metaSettings(app.env);
  let file;
  try {
    file = await downloadMedia(m, app.graphFetch, msg.media.id, RECEIPT_MAX);
  } catch (e) {
    app.log(`[pay] customer ${c.id}: the file from ${masked(msg.from)} could not be fetched: ${e.message}`);
    await tell(app, c, 'receipt', e.status === 413 ? PAY.tooLarge : PAY.unreadable);
    return true;
  }
  const type = sniff(file.data);
  if (!type) {
    await tell(app, c, 'receipt', PAY.unreadable);
    return true;
  }
  const sha256 = createHash('sha256').update(file.data).digest('hex');
  const same = db.get("SELECT id, decision FROM receipts WHERE customer_id = ? AND sha256 = ? AND (decided_at IS NULL OR decision = 'paid') ORDER BY id LIMIT 1", c.id, sha256);
  if (same) {
    await tell(app, c, 'receipt', same.decision === 'paid' ? PAY.againPaid : PAY.again);
    return true;
  }
  const lately = db.get("SELECT count(*) AS n FROM receipts WHERE customer_id = ? AND source = 'whatsapp' AND created_at > ?", c.id, nowIso(now() - DAY)).n;
  if (lately >= RECEIPTS_PER_DAY) {
    app.log(`[pay] customer ${c.id}: more than ${RECEIPTS_PER_DAY} pictures in 24 hours, not kept`);
    return true;
  }
  const id = Number(
    db.run(
      'INSERT INTO receipts (customer_id, business, source, phone, msg_id, type, size, sha256, file, owed_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      c.id,
      c.business,
      'whatsapp',
      msg.from,
      msg.id || null,
      type,
      file.data.length,
      sha256,
      file.data,
      JSON.stringify({ ...b.owed, paidUntil: b.paidUntil }),
      nowIso()
    ).lastInsertRowid
  );
  app.log(`[pay] customer ${c.id}: receipt ${id} came (${type}, ${file.data.length} bytes)`);
  await tell(app, c, 'receipt', PAY.received);
  await alertOwner(app, `receipt:${id}`, ALERT.receipt(whoIs(c.business, c.phone)), ALERT.body.check(adminLink(app.env, `/admin/receipts/${id}`)), 24 * 60);
  return true;
}

// ---- recording a payment

/**
 * Record the month now owed, inside a transaction the caller holds. `expect` is the paid-until day the admin's page
 * showed ('' for none): if it changed meanwhile (another receipt, the other button, a page left open), nothing is
 * recorded (already_paid). `month`: the month a receipt asked for when it came, used while the paid-until day is still
 * the one it saw, so a slow check never costs the customer days. Answers the bill { from, until, net, vat, total }.
 */
function recordMonth(db, customerId, expect, month = null, today = israelDate()) {
  const c = db.get('SELECT * FROM customers WHERE id = ?', customerId);
  if (!c) throw new PayError('no_customer');
  if ((c.paid_until ?? '') !== String(expect ?? '')) throw new PayError('already_paid');
  const owed = month && (month.paidUntil ?? null) === (c.paid_until ?? null) ? month : billingOf(c, today).owed;
  if (!owed) throw new PayError('nothing_due');
  const bill = { from: owed.from, until: owed.until, net: owed.net, vat: owed.vat, total: owed.total };
  db.run('UPDATE customers SET paid_until = ?, updated_at = ? WHERE id = ?', bill.until, nowIso(), customerId);
  return bill;
}

/** After a payment is recorded: the invoice in Morning, then a line to the customer. Never throws. */
async function afterPaid(app, receiptId) {
  const r = receiptById(app.db, receiptId);
  let invoice = { state: 'off' };
  try {
    invoice = await invoiceReceipt(app, receiptId);
  } catch (e) {
    app.log(`[pay] receipt ${receiptId}: Morning: ${e.message}`);
  }
  const c = r?.customer_id && app.db.get('SELECT * FROM customers WHERE id = ?', r.customer_id);
  if (c) await tell(app, c, 'paid', PAY.paid({ business: c.business, until: dateHe(r.bill.until), url: invoice.url || '', setup: !c.assistant }));
  // Their own number for the forwarded calls, the first time they pay (numbers.js).
  if (c && !c.assistant && c.status !== 'stopped') await giveNumber(app, c);
  return invoice;
}

/**
 * The admin's answer to a receipt: 'paid' records the month (guarded by `expect`, see recordMonth), 'not_paid' records
 * nothing. A receipt is decided once, so it is its own one-time token: the same form sent twice records one month.
 * Answers { bill, invoice }. Throws PayError: no_receipt, already_paid, decided, nothing_due, no_customer.
 */
export async function decideReceipt(app, id, decision, expect) {
  const { db } = app;
  const bill = db.tx(() => {
    const r = receiptById(db, id);
    if (!r) throw new PayError('no_receipt');
    const claimed = db.run('UPDATE receipts SET decided_at = ?, decision = ? WHERE id = ? AND decided_at IS NULL', nowIso(), decision, r.id);
    if (Number(claimed.changes) !== 1) throw new PayError(decision === 'paid' && r.decision === 'paid' ? 'already_paid' : 'decided');
    if (decision !== 'paid') return null;
    if (!r.customer_id) throw new PayError('no_customer');
    const b = recordMonth(db, r.customer_id, expect, r.owed);
    db.run('UPDATE receipts SET bill_json = ? WHERE id = ?', JSON.stringify(b), r.id);
    return b;
  });
  if (!bill) return { bill: null, invoice: null };
  app.log(`[pay] receipt ${id}: paid, until ${bill.until}`);
  return { bill, invoice: await afterPaid(app, id) };
}

/** "התקבל תשלום": a month recorded with no picture, kept as a receipt marked paid. Answers { id, bill, invoice }. */
export async function manualPayment(app, c, expect) {
  const { db } = app;
  const { id, bill } = db.tx(() => {
    const b = recordMonth(db, c.id, expect);
    const at = nowIso();
    const rid = Number(db.run("INSERT INTO receipts (customer_id, business, source, decision, decided_at, bill_json, created_at) VALUES (?, ?, 'manual', 'paid', ?, ?, ?)", c.id, c.business, at, JSON.stringify(b), at).lastInsertRowid);
    return { id: rid, bill: b };
  });
  app.log(`[pay] customer ${c.id}: paid by hand, until ${bill.until}`);
  return { id, bill, invoice: await afterPaid(app, id) };
}

/** "להפיק חשבונית שוב" on a receipt whose invoice failed. */
export const retryInvoice = (app, id) => invoiceReceipt(app, id);

// ---- once a minute

/** Which reminder is due today for where the customer stands, or null. */
export function reminderDue(b, today) {
  if (!b.paidUntil || b.state === 'free' || b.state === 'ending' || b.state === 'ended') return null;
  const d = daysBetween(b.paidUntil, today);
  if (d >= -2 && d <= 0) return 'soon';
  if (d >= 1 && d <= 2) return 'due';
  if (d === 3) return 'last';
  if (d >= 4 && d <= 10) return 'stopped';
  return null;
}

/**
 * The reminders, the customers whose last day passed, and the files past their 90 days. `at` moves time for the tests.
 */
export async function payTick(app, at = now()) {
  const { db } = app;
  const today = israelDate(at);
  for (const c of db.all("SELECT * FROM customers WHERE ends_on IS NOT NULL AND ends_on < ? AND status != 'stopped'", today)) {
    db.run("UPDATE customers SET status = 'stopped', stopped_at = ?, updated_at = ? WHERE id = ?", nowIso(at), nowIso(at), c.id);
    app.log(`[pay] customer ${c.id}: the last paid day passed, stopped`);
  }
  if (!quiet(at) && metaSettings(app.env).ready && paySettings(app.env).details) {
    for (const c of db.all("SELECT * FROM customers WHERE status IN ('active', 'paused') AND free = 0 AND ends_on IS NULL AND paid_until IS NOT NULL")) {
      const kind = reminderDue(billingOf(c, today), today);
      if (!kind || db.get('SELECT 1 FROM pay_notices WHERE customer_id = ? AND until = ? AND kind = ?', c.id, c.paid_until, kind)) continue;
      // A receipt that waits for the admin is the customer having paid: no reminder over it.
      if (db.get('SELECT 1 FROM receipts WHERE customer_id = ? AND decided_at IS NULL', c.id)) continue;
      await sendPayment(app, c, kind, today);
    }
  }
  db.run('UPDATE receipts SET file = NULL WHERE file IS NOT NULL AND created_at < ?', nowIso(at - num(app.env.RECEIPT_FILE_DAYS, RECEIPT_FILE_DAYS) * DAY));
  db.run('DELETE FROM pay_notices WHERE at < ?', nowIso(at - 400 * DAY));
}
