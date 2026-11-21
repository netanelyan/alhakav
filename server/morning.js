import { MINUTE, israelDate, now, nowIso } from './clock.js';
import { VAT, dateHe } from './billing.js';
import { PAY } from './copy.js';

// The invoice-receipt in Morning (Green Invoice), issued when the admin records a payment (pay.js), as
// openfrequency-accounts' src/accounts/morning.js does it (Morning's API as developers.morning.co described it on
// 2026-11-01). The payment is recorded first and always: an invoice that cannot be issued never holds it up, and the
// receipt's page says why and offers to try again.
//
//   1. A token: POST {grant_type: "client_credentials", client_id, client_secret}; the answer { accessToken,
//      expiresAt (unix seconds) } is kept in memory until a minute before it ends. The secret and the token are never
//      logged, stored, or put in an error or on a page.
//   2. GET /documents/info?type=320: the business as Morning has it. Exempt from VAT, or a VAT rate that is not ours,
//      and nothing is issued: a wrong document is worse than none.
//   3. POST /documents: a חשבונית מס/קבלה (type 320), in Hebrew and shekels: one row for the month, 149 ₪ with VAT
//      added (vatType 0), and one payment, a bank transfer (type 4), of the total. With the customer's email Morning
//      also emails it to them.
//
// One receipt, one document, ever: the receipt is claimed ('issuing') by one UPDATE that only a receipt with no
// document and no request out can pass, and the document's id is written the moment it comes back. A request still
// out after 10 minutes (the process stopped mid-way) may be tried again, and the page says to look in Morning first.
//
// MORNING_CLIENT_ID and MORNING_CLIENT_SECRET turn it on (a Morning plan that includes the API); MORNING_ENV=sandbox
// points it at Morning's sandbox. vatRate comes as 0.18 (read 2026-11-21; 18 is read too). UNVERIFIED until the first
// invoice, as in openfrequency: the error body's field names, and the client's taxId and address fields.

export const MORNING_URLS = {
  production: { token: 'https://api.morning.co/idp/v1/oauth/token', api: 'https://api.greeninvoice.co.il/api/v1' },
  sandbox: { token: 'https://api.sandbox.morning.dev/idp/v1/oauth/token', api: 'https://sandbox.d.greeninvoice.co.il/api/v1' },
};
export const ISSUING_STALE_MS = 10 * MINUTE;
export const MORNING_TIMEOUT_MS = 15_000;

/** The settings, or null while Morning is off (either key unset, or MORNING_ENV not one we know). */
export function morningConfig(env) {
  const clientId = String(env.MORNING_CLIENT_ID || '').trim();
  const clientSecret = String(env.MORNING_CLIENT_SECRET || '').trim();
  const mode = String(env.MORNING_ENV || '').trim() || 'production';
  if (!clientId || !clientSecret || !Object.hasOwn(MORNING_URLS, mode)) return null;
  return { clientId, clientSecret, mode, ...MORNING_URLS[mode] };
}

export class MorningError extends Error {
  /** `code`: Morning's error code or ours (timeout, unreachable, bad_answer); `detail`: Morning's own words, cut. */
  constructor(code, { status = null, detail = '', step = '' } = {}) {
    super(String(code));
    this.code = String(code);
    this.status = status;
    this.detail = String(detail || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200);
    this.step = step;
  }
}

/** The client: { mode, info(), issue(doc) }, or null with no config. */
export function morningClient(config, f = globalThis.fetch, { timeoutMs = MORNING_TIMEOUT_MS } = {}) {
  if (!config) return null;
  let kept = null;
  const call = async (url, init, step) => {
    try {
      return await f(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw new MorningError(e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'timeout' : 'unreachable', { step });
    }
  };
  const body = (res) => res.json().catch(() => null);
  const refuse = async (res, step) => {
    const b = await body(res);
    const code = b?.errorCode ?? b?.code ?? b?.error ?? `http_${res.status}`;
    throw new MorningError(typeof code === 'object' ? `http_${res.status}` : code, { status: res.status, detail: b?.errorMessage ?? b?.message ?? b?.error_description ?? '', step });
  };
  async function token() {
    if (kept && now() < kept.until) return kept.value;
    const res = await call(config.token, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ grant_type: 'client_credentials', client_id: config.clientId, client_secret: config.clientSecret }) }, 'token');
    if (!res.ok) await refuse(res, 'token');
    const b = await body(res);
    if (typeof b?.accessToken !== 'string' || !b.accessToken) throw new MorningError('bad_answer', { status: res.status, step: 'token' });
    const until = Number(b.expiresAt) * 1000 - MINUTE;
    kept = Number.isFinite(until) && until > now() ? { value: b.accessToken, until } : null;
    return b.accessToken;
  }
  async function api(method, path, payload, step) {
    const t = await token();
    const res = await call(`${config.api}${path}`, { method, headers: { authorization: `Bearer ${t}`, accept: 'application/json', ...(payload ? { 'content-type': 'application/json' } : {}) }, ...(payload ? { body: JSON.stringify(payload) } : {}) }, step);
    if (res.status === 401) kept = null;
    if (!res.ok) await refuse(res, step);
    const b = await body(res);
    if (!b || typeof b !== 'object') throw new MorningError('bad_answer', { status: res.status, step });
    return b;
  }
  return { mode: config.mode, info: () => api('GET', '/documents/info?type=320', null, 'info'), issue: (doc) => api('POST', '/documents', doc, 'issue') };
}

/**
 * Why Morning's business does not fit what was charged, as { reason, rate? }, or null when it fits: exempt while VAT
 * was added, a VAT rate other than ours (read as a fraction, 0.18, or as percent, 18), or no rate at all.
 */
export function vatProblem(info) {
  if (info?.exemption === true) return { reason: 'exempt' };
  const raw = Number(info?.vatRate);
  if (info?.vatRate == null || !Number.isFinite(raw)) return { reason: 'vat_unknown' };
  const rate = raw > 1 ? raw / 100 : raw;
  return Math.abs(rate - VAT) > 1e-9 ? { reason: 'vat_rate', rate: `${Math.round(rate * 10000) / 100}%` } : null;
}

/** The document Morning is asked for (step 3 above), from the receipt's bill and the customer's invoice details. */
export function documentFor({ name, taxId, address, email, bill, today = israelDate() }) {
  return {
    type: 320,
    lang: 'he',
    currency: 'ILS',
    vatType: 0,
    date: today,
    description: PAY.invoice.description,
    client: { name, ...(taxId ? { taxId } : {}), ...(address ? { address } : {}), ...(email ? { emails: [email] } : {}), add: true },
    income: [{ description: PAY.invoice.row(dateHe(bill.from), dateHe(bill.until)), quantity: 1, price: bill.net, currency: 'ILS', vatType: 0 }],
    payment: [{ date: today, type: 4, price: bill.total, currency: 'ILS' }],
    ...(email ? { attachment: true, emailContent: PAY.invoice.email } : {}),
  };
}

/**
 * Issue the invoice-receipt for a receipt marked paid. Answers { state, number?, url?, error? }:
 *   off       Morning is not set up
 *   issued    issued now
 *   already   it has one; nothing asked
 *   busy      a request for it is out; nothing asked
 *   blocked   Morning's VAT settings do not fit ({ error: { reason, rate? } }); nothing issued
 *   failed    Morning refused or did not answer ({ error: { code, status, detail, step } })
 *   nothing   the receipt is not one marked paid, or it is for 0 ₪
 */
export async function invoiceReceipt(app, receiptId, today = israelDate()) {
  const { db } = app;
  if (!app.morning) return { state: 'off' };
  const id = Number(receiptId);
  const bill = JSON.parse(db.get('SELECT bill_json FROM receipts WHERE id = ?', id)?.bill_json || 'null');
  if (!(Number(bill?.total) > 0)) return { state: 'nothing' };
  const claimed = db.run(
    `UPDATE receipts SET morning_state = 'issuing', morning_at = ?, morning_error_json = NULL
      WHERE id = ? AND decision = 'paid' AND bill_json IS NOT NULL AND morning_doc_id IS NULL
        AND (morning_state IS NULL OR morning_state IN ('failed', 'blocked') OR (morning_state = 'issuing' AND morning_at < ?))`,
    nowIso(),
    id,
    nowIso(now() - ISSUING_STALE_MS)
  );
  if (Number(claimed.changes) !== 1) {
    const r = db.get('SELECT morning_state, morning_doc_id FROM receipts WHERE id = ?', id);
    return { state: r?.morning_doc_id ? 'already' : r?.morning_state === 'issuing' ? 'busy' : 'nothing' };
  }
  const r = db.get('SELECT r.business, c.invoice_name, c.tax_id, c.address, c.email FROM receipts r LEFT JOIN customers c ON c.id = r.customer_id WHERE r.id = ?', id);
  const stop = (state, error) => {
    db.run('UPDATE receipts SET morning_state = ?, morning_error_json = ? WHERE id = ?', state, JSON.stringify(error), id);
    app.log(`[morning] receipt ${id}: ${state} ${error.code || error.reason || ''} ${error.status || ''} ${error.step || ''}`);
    return { state, error };
  };
  let doc;
  try {
    const problem = vatProblem(await app.morning.info());
    if (problem) return stop('blocked', problem);
    doc = await app.morning.issue(documentFor({ name: r.invoice_name || r.business, taxId: r.tax_id, address: r.address, email: r.email, bill, today }));
    if (doc?.id == null || doc.number == null) throw new MorningError('bad_answer', { step: 'issue' });
  } catch (e) {
    return stop('failed', e instanceof MorningError ? { code: e.code, status: e.status, detail: e.detail, step: e.step } : { code: 'error', status: null, detail: '', step: '' });
  }
  // Issued: from here on it is never asked for again.
  const number = String(doc.number).slice(0, 40);
  const url = [doc.url?.origin, doc.url?.he].find((u) => typeof u === 'string' && /^https:\/\//i.test(u)) || null;
  db.run("UPDATE receipts SET morning_state = 'issued', morning_doc_id = ?, morning_number = ?, morning_url = ? WHERE id = ?", String(doc.id), number, url, id);
  app.log(`[morning] receipt ${id}: invoice-receipt ${number}`);
  return { state: 'issued', number, url };
}
