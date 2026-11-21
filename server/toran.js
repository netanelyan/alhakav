import { adminLink, alertOwner, toranBase, whoIs } from './alerts.js';
import { billingOf, dateHe, money } from './billing.js';
import { HOUR, israelDate, now, nowIso } from './clock.js';
import { ALERT, MSG } from './copy.js';
import { createCustomer, getCustomer } from './customers.js';
import { num } from './env.js';
import { metaSettings, sendText } from './meta.js';
import { customerByPhone, sendPayment } from './pay.js';
import { masked } from './phones.js';
import { pageUrl } from './demo.js';

// Toran answers on the business number (docs/toran.md). openfrequency-toran's agent, the one that answers
// OpenFrequency's own support, answers as על הקו too: from what the site says (its export, server/support.js), with its
// guard and its limits. This server stays the one that owns the number: it keeps every message, and it sends Toran's
// answer itself, as plain text, since the person just wrote. Toran runs on the same machine, behind
// POST /internal/company/answer, and never writes to WhatsApp for על הקו.
//
//   who            everyone who writes to the business number, after what this server does by itself: a stop word,
//                  "כן, שלחו", an away message and a transfer's picture are still handled here and never go to Toran
//   when           after they stop writing for a moment (TORAN_DEBOUNCE_MS, 3 seconds), their messages at once
//   a person       what the admin wrote to them from the lead's page since Toran last answered goes with their next
//                  message, and an answer of Toran's never goes within 12 hours of one of the admin's
//   joining        Toran's handoff "join" (they want to start, with their business name): they become a customer, the
//                  amount and the transfer details go at once (pay.js sendPayment), and the admin is told
//   a handoff      anything else Toran passes on: the admin is told on their phone (alerts.js)
//   no Toran       not set up, down or slow: someone who wrote to us first gets the explanation once (MSG.welcome), and
//                  the admin is told someone wrote
//
//   OF_INTERNAL_TOKEN, TORAN_URL   as alerts.js
//   TORAN_DOMAIN                   the company store's domain in Toran, SITE_URL's host by default
//
// Nothing here throws to the webhook.

export const PAUSE_MS = 12 * HOUR;

export function toranSettings(env) {
  const { url, token } = toranBase(env);
  let host = '';
  try {
    host = new URL(String(env.SITE_URL || '')).hostname;
  } catch {}
  const domain = String(env.TORAN_DOMAIN || host).trim().toLowerCase();
  return { url, token, domain, ready: token.length >= 32 && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain), delay: num(env.TORAN_DEBOUNCE_MS, 3000), site: String(env.SITE_URL || '').trim() };
}

/** What is waiting to be answered, by phone: the messages, the timer, and the answer under way (one at a time). */
export const toranState = () => ({ queues: new Map() });

const clean = (s, n = 80) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const leadByPhone = (db, phone) => db.get('SELECT * FROM leads WHERE mobile = ? ORDER BY (first_at IS NULL), id DESC LIMIT 1', phone);
const stopped = (db, phone) => Boolean(db.get('SELECT 1 FROM stops WHERE phone = ?', phone));
/** The admin answered them by hand in the last 12 hours: the conversation is theirs. */
const personAnswered = (db, phone) => Boolean(db.get("SELECT 1 FROM messages WHERE phone = ? AND dir = 'out' AND kind = 'reply' AND status != 'failed' AND at > ?", phone, nowIso(now() - PAUSE_MS)));

function keepOut(db, lead, kind, body, { waId = null, status = 'sent', error = null } = {}) {
  db.run('INSERT INTO messages (lead_id, phone, dir, kind, body, wa_id, status, error, day, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', lead.id, lead.mobile, 'out', kind, body, waId, status, error, israelDate(), nowIso());
}

/** Plain text from the business number, kept with the lead. Answers whether it went. */
async function say(app, lead, kind, body) {
  const m = metaSettings(app.env);
  if (!m.ready) return false;
  try {
    keepOut(app.db, lead, kind, body, { waId: (await sendText(m, app.graphFetch, lead.mobile, body)) || null });
    return true;
  } catch (e) {
    app.log(`[toran] ${kind} to ${masked(lead.mobile)} (lead ${lead.id}) not sent: ${e.code || ''} ${e.message}`);
    keepOut(app.db, lead, kind, body, { status: 'failed', error: e.message });
    return false;
  }
}

/**
 * A message for Toran to answer, kept until they stop writing for a moment. With TORAN_DEBOUNCE_MS 0 (the tests) it is
 * answered at once, and the caller can wait for it. Without Toran set up, the answer without it, at once.
 */
export function queueAnswer(app, lead, m) {
  const t = toranSettings(app.env);
  if (!t.ready) return fallback(app, lead, false);
  const phone = lead.mobile;
  const q = app.toran.queues.get(phone) || { messages: [], timer: null, chain: Promise.resolve() };
  app.toran.queues.set(phone, q);
  q.messages.push({ id: m.id || `local-${now()}-${q.messages.length}`, text: String(m.text || '').trim().slice(0, 4096) || '[הודעה ריקה]', at: nowIso(m.at || now()), name: m.name || '' });
  clearTimeout(q.timer);
  const go = () => {
    const batch = q.messages.splice(0);
    if (batch.length) q.chain = q.chain.then(() => answer(app, phone, batch)).catch((e) => app.log(`[toran] ${masked(phone)}: ${e.stack || e}`));
    return q.chain;
  };
  if (t.delay <= 0) return go();
  q.timer = setTimeout(go, t.delay);
  q.timer.unref?.();
  return null;
}

/** Who this is here, in a few English lines for Toran's agent (never shown to them). env: for their page's address. */
export function contextOf(db, lead, phone, env = {}) {
  const c = customerByPhone(db, phone);
  if (c) {
    const b = billingOf(c);
    const lines = [`A customer of על הקו: business "${c.business}".`];
    lines.push({ setup: 'We are setting their assistant up by hand; it does not answer their callers yet.', active: 'Their assistant is on.', paused: 'Their assistant is paused.', stopped: 'They stopped the service.' }[c.status] || '');
    if (b.state === 'free') lines.push('They do not pay (a pilot).');
    else if (b.state === 'new') lines.push(`They have not paid their first month yet (${money(b.owed.total)} ₪ with VAT).`);
    else if (b.paidUntil) lines.push(`Paid until ${dateHe(b.paidUntil)}.${b.owed ? ` The next month is due: ${money(b.owed.total)} ₪ with VAT.` : ''}`);
    const ask = db.get("SELECT at FROM pay_notices WHERE customer_id = ? AND status = 'sent' ORDER BY at DESC LIMIT 1", c.id);
    if (ask && b.owed) lines.push(`We sent them the amount and the transfer details on ${dateHe(israelDate(Date.parse(ask.at)))}; after the transfer they send a screenshot of it here, and we check the bank.`);
    if (db.get('SELECT 1 FROM receipts WHERE customer_id = ? AND decided_at IS NULL', c.id)) lines.push('A transfer screenshot from them is waiting for us to check the bank.');
    return lines.filter(Boolean).join(' ');
  }
  if (lead.first_at) return [`A tradesperson we wrote to first${lead.name ? ` (${lead.name})` : ''}.`, lead.page_code ? `Our first message linked a page we made for their business (${pageUrl(env, lead.page_code)}), where they can see how it would work for them and try המוקדן on themselves.` : '', lead.yes_at ? 'They said yes and already got the page again, with the price.' : ''].filter(Boolean).join(' ');
  return 'They wrote to us first, most likely from the website.';
}

async function answer(app, phone, batch) {
  const { db } = app;
  const t = toranSettings(app.env);
  const lead = leadByPhone(db, phone);
  if (!lead || stopped(db, phone)) return;
  const name = batch.findLast((b) => b.name)?.name || '';
  const fresh = !lead.toran_at && !lead.first_at && lead.closed_why !== 'customer' && !db.get("SELECT 1 FROM messages WHERE phone = ? AND dir = 'out' LIMIT 1", phone);
  const asked = nowIso();
  // Toran takes at most 20 of each in one call (its src/channels/external.ts): the newest.
  const operator = db.all("SELECT body AS text, at FROM messages WHERE phone = ? AND dir = 'out' AND kind = 'reply' AND status != 'failed' AND at > ? ORDER BY at, id", phone, lead.toran_at || '').slice(-20).map((o) => ({ text: String(o.text).slice(0, 4096), at: o.at }));
  batch = batch.slice(-20);
  let r;
  try {
    const res = await app.toranFetch(`${t.url}/internal/company/answer`, {
      method: 'POST',
      headers: { authorization: `Bearer ${t.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ domain: t.domain, phone, name: name || null, messages: batch.map(({ id, text, at }) => ({ id, text, at })), operator, context: contextOf(db, lead, phone, app.env) }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) throw new Error(`Toran answered ${res.status}`);
    r = await res.json();
  } catch (e) {
    app.log(`[toran] ${masked(phone)} (lead ${lead.id}): no answer (${e.message})`);
    return fallback(app, lead, true);
  }
  db.run('UPDATE leads SET toran_at = ? WHERE id = ?', asked, lead.id);
  if (r?.reply && !personAnswered(db, phone)) await say(app, lead, 'bot', String(r.reply).slice(0, 4000));
  if (fresh) await alertOwner(app, `new:${lead.id}`, ALERT.fresh(whoIs(name || lead.name, phone)), [clean(batch.map((b) => b.text).join(' '), 300), ALERT.body.open(adminLink(app.env, `/admin/leads/${lead.id}`))].join('\n'), 24 * 60);
  if (r?.handoff) await onHandoff(app, leadByPhone(db, phone) || lead, r.handoff, name);
}

/**
 * Toran could not answer (not set up, down, slow): someone who wrote to us first and never heard from us gets the
 * explanation, once, and the admin is told.
 */
async function fallback(app, lead, failed) {
  const { db } = app;
  if (stopped(db, lead.mobile)) return;
  const stranger = !lead.first_at && lead.closed_why !== 'customer';
  if (stranger && !db.get("SELECT 1 FROM messages WHERE phone = ? AND dir = 'out' LIMIT 1", lead.mobile)) await say(app, lead, 'welcome', MSG.welcome(toranSettings(app.env).site));
  const who = whoIs(lead.name, lead.mobile);
  await alertOwner(app, `wrote:${lead.id}`, failed ? ALERT.quiet(who) : ALERT.fresh(who), ALERT.body.answer(adminLink(app.env, `/admin/leads/${lead.id}`)), 6 * 60);
}

async function onHandoff(app, lead, h, name) {
  const { db } = app;
  const reason = String(h?.reason || '');
  const who = whoIs(name || lead.name, lead.mobile);
  const page = adminLink(app.env, `/admin/leads/${lead.id}`);
  if (reason === 'bot') return; // another business's bot: Toran stays quiet, and so do we
  if (reason === 'join') return join(app, lead, h, name, who);
  if (reason === 'stop' && !customerByPhone(db, lead.mobile)) {
    // They asked us to stop in words the stop list does not know: the same as "לא, תודה".
    const at = nowIso();
    db.tx(() => {
      db.run('INSERT OR IGNORE INTO stops (phone, why, at) VALUES (?, ?, ?)', lead.mobile, clean(`Toran: ${h.summary || ''}`, 120), at);
      db.run("UPDATE leads SET stage = 'closed', closed_why = 'stopped', out_state = 'stopped', updated_at = ? WHERE mobile = ? AND coalesce(closed_why, '') != 'customer'", at, lead.mobile);
    });
    app.log(`[toran] ${masked(lead.mobile)} asked us to stop (lead ${lead.id})`);
    return;
  }
  await alertOwner(app, `handoff:${lead.id}`, ALERT.handoff(who), [clean(h.summary, 600), ALERT.body.open(page)].filter(Boolean).join('\n'), 30);
}

/** They want to join: a customer from the lead, the amount and the transfer details at once, and the admin told. */
async function join(app, lead, h, name, who) {
  const { db } = app;
  let c = customerByPhone(db, lead.mobile);
  if (!c) {
    const business = clean(h.business) || clean(lead.msg_name) || clean(lead.name) || clean(name);
    const r = createCustomer(db, { name: clean(name) || business, business, trade: lead.trade, phone: lead.mobile }, lead.id);
    if (!r.ok) {
      app.log(`[toran] ${masked(lead.mobile)} wants to join, but no customer could be made (lead ${lead.id})`);
      return alertOwner(app, `join:lead:${lead.id}`, ALERT.joinFailed(who), [ALERT.body.joinWhy.customer, ALERT.body.open(adminLink(app.env, `/admin/leads/${lead.id}`))].join('\n'), 6 * 60);
    }
    c = getCustomer(db, r.id);
    db.run("UPDATE leads SET stage = 'closed', closed_why = 'customer', later_until = NULL, updated_at = ? WHERE id = ?", nowIso(), lead.id);
    app.log(`[toran] ${masked(lead.mobile)} joined: customer ${c.id} (lead ${lead.id})`);
  }
  // Asked for it again within six hours: the details they got stand.
  const recent = db.get("SELECT 1 FROM pay_notices WHERE customer_id = ? AND kind = 'ask' AND status = 'sent' AND at > ?", c.id, nowIso(now() - 6 * HOUR));
  const sent = recent ? { ok: true } : await sendPayment(app, c, 'ask');
  const link = ALERT.body.open(adminLink(app.env, `/admin/customers/${c.id}`));
  const whoC = whoIs(c.business, c.phone);
  if (sent.ok) return alertOwner(app, `join:${c.id}`, ALERT.join(whoC), link, 6 * 60);
  return alertOwner(app, `join:${c.id}`, ALERT.joinFailed(whoC), [ALERT.body.joinWhy[sent.why] || sent.why, link].join('\n'), 6 * 60);
}
