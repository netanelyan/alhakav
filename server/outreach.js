import { DAY, HOUR, MINUTE, afterQuiet, israelDate, now, nowIso, quiet, whenHe } from './clock.js';
import { ALERT, CLOSED, DIGEST, MSG, SCENE, T } from './copy.js';
import { num } from './env.js';
import { GraphError, assistSettings, knownStatus, metaSettings, numberQuality, parseWebhook, pickTemplate, review, sendTemplate, sendText } from './meta.js';
import { onAssistMessage, onAssistStatus } from './service.js';
import { adminLink, alertOwner, ownerNumber, whoIs } from './alerts.js';
import { dayCounts } from './digest.js';
import { customerByPhone, takeReceipt } from './pay.js';
import { isMobile, local, masked } from './phones.js';
import { asksToStop, automatic } from './stopWords.js';
import { queueAnswer } from './toran.js';
import { bizOf, pageCodeOf, pageUrl } from './demo.js';

// Writing to a tradesperson from the business number, and what happens when they answer. The guardrails are
// openfrequency-toran's (src/ops/outreach.ts), because the number's rating is what everything else rides on: Meta
// asks for a person's opt-in before a business writes first, and a template that people block or report is paused,
// then disabled, and takes the number's rating with it.
//
//   - the first message goes when the admin presses the button, or when the scheduled task asks (autopilot.js,
//     docs/autopilot.md); the one reminder only from the admin
//   - the way out is on the message: "לא, תודה", or "לא", "הסר", "די" in any short form at any time, puts the number in
//     `stops`, says so once, closes the lead, and no message goes to it again
//   - at most OUTREACH_DAILY (10) first messages and reminders a day, by Israel's calendar day
//   - never from 20:00 to 09:00, on Shabbat or a holiday, or the afternoon before one (clock.js quiet)
//   - the number's quality read from Meta before each one (ten minutes at a time): anything but GREEN or UNKNOWN stops
//   - one first message and one reminder per lead, the reminder four days after (and not in a quiet hour), only while
//     they have not answered, and only to a mobile read from their own site
//
// The first message carries their own page (demo.js), as the template's link button. What they answer: "כן" (or the
// old template's "כן, שלחו" button) gets the page again with the price at once, as plain text, since they just wrote; any other message marks them as answering and opens the 24 hours in which the admin can
// answer from the lead's page; an away message or a bot's is kept and counts for nothing. Someone who writes to the
// business number and is not a lead becomes one ("כתבו אלינו"). A customer's lead stays a customer's whatever they
// write, and a picture or a PDF from a customer while they owe a payment is the transfer's receipt (pay.js).
//
// Nothing here throws to its caller. A number in a log line is its last four digits.

export const FOLLOWUP_DAYS = 4;
export const WINDOW_MS = 24 * HOUR;

export function outreachSettings(env) {
  return {
    daily: num(env.OUTREACH_DAILY, 10),
    first: String(env.TEMPLATE_FIRST || 'alhakav_page'),
    // The first message opening with a moment from their trade (copy.js SCENE); empty turns it off.
    firstTrade: String(env.TEMPLATE_FIRST_TRADE ?? 'alhakav_page_trade').trim(),
    // The reminder in the new look first, the approved one until Meta approves it (meta.js pickTemplate).
    reminders: String(env.TEMPLATE_REMINDER || '').trim() ? [String(env.TEMPLATE_REMINDER).trim()] : ['alhakav_page_reminder_v2', 'alhakav_page_reminder'],
    sender: String(env.SENDER_LINE || '').trim(),
    site: String(env.SITE_URL || '').trim(),
  };
}

/** The template's {{1}}: "אצל אבי אינסטלציה", or "אצלכם" with no name. */
export function nameParam(lead) {
  const n = String(lead.msg_name || lead.name || '').trim();
  return n ? `אצל ${n}` : 'אצלכם';
}

/** The first message's opening, a moment from their trade's work (copy.js SCENE). */
export const sceneOf = (lead) => SCENE[lead.trade] || SCENE.any;

/**
 * The first message or the reminder, as the tradesperson reads it, with their page (made first: demo.js pageCodeOf).
 * The first opens with their trade's moment when it goes as alhakav_page_trade (`trade`): by hand always, from the
 * business number once Meta approved it (as last read: meta.js knownStatus).
 */
export function messageText(stage, lead, env, { byHand = false, trade } = {}) {
  const o = outreachSettings(env);
  const words = stage === 'first' && (trade ?? (byHand || (Boolean(o.firstTrade) && knownStatus(o.firstTrade) === 'APPROVED')));
  return MSG[words ? 'firstTrade' : stage](nameParam(lead), pageUrl(env, lead.page_code || ''), o.sender || MSG.senderMissing, byHand, sceneOf(lead));
}

/**
 * The first message's template: the one that opens with their trade's moment once Meta approved it, until then the
 * one everyone gets. Answers its name and its body's variables for this lead.
 */
export async function firstTemplate(app, lead) {
  const o = outreachSettings(app.env);
  const m = metaSettings(app.env);
  if (o.firstTrade && m.wabaId && (await review(m, app.graphFetch, o.firstTrade)).status === 'APPROVED') {
    return { name: o.firstTrade, trade: true, params: lead ? [sceneOf(lead), nameParam(lead)] : [] };
  }
  return { name: o.first, trade: false, params: lead ? [nameParam(lead)] : [] };
}

export const stopped = (db, phone) => Boolean(phone && db.get('SELECT 1 FROM stops WHERE phone = ?', phone));

/** First messages and reminders that left the business number today (by hand ones go from the admin's own phone). */
export const sentToday = (db, at = now()) => db.get("SELECT count(*) AS n FROM messages WHERE dir = 'out' AND kind IN ('first', 'reminder') AND wa_id IS NOT NULL AND day = ?", israelDate(at)).n;

export const reminderDueAt = (lead) => afterQuiet(Date.parse(lead.first_at) + FOLLOWUP_DAYS * DAY);
/** The first message never reached them (no WhatsApp on the number, or Meta held it): a reminder would not either. */
export const unreached = (lead) => ['failed', 'undelivered'].includes(lead.out_state);

export const reminderDue = (lead, at = now()) => Boolean(lead.stage === 'waiting' && lead.first_at && !lead.reminder_at && !lead.yes_at && !lead.replied_at && !unreached(lead) && reminderDueAt(lead) <= at);

/** Until when the admin may answer them in plain text: 24 hours from their last message. */
export const windowUntil = (lead) => (lead.last_in_at ? Date.parse(lead.last_in_at) + WINDOW_MS : 0);
export const windowOpen = (lead, at = now()) => windowUntil(lead) > at;

/**
 * Why this message may not go now, or null. byHand: from the admin's own phone, which the day's cap (the business
 * number's) does not count.
 */
export function blocked(app, lead, stage, { at = now(), byHand = false } = {}) {
  if (!isMobile(lead.mobile)) return { why: 'noMobile' };
  if (stopped(app.db, lead.mobile)) return { why: 'stopped' };
  if (lead.stage === 'closed') return { why: 'closed' };
  if (stage === 'first' && lead.first_at) return { why: 'already' };
  if (stage === 'reminder') {
    if (!lead.first_at) return { why: 'noFirst' };
    if (lead.reminder_at) return { why: 'done' };
    if (lead.yes_at || lead.replied_at) return { why: 'answered' };
    if (unreached(lead)) return { why: 'unreached' };
    const due = reminderDueAt(lead);
    if (due > at) return { why: 'notDue', until: due };
  }
  if (quiet(at)) return { why: 'quiet', until: afterQuiet(at) };
  if (!byHand) {
    const n = sentToday(app.db, at);
    if (n >= outreachSettings(app.env).daily) return { why: 'cap', n };
  }
  return null;
}

export function blockedText(b, at = now()) {
  if (b.why === 'quiet') return T.guard.quiet(whenHe(b.until, at));
  if (b.why === 'notDue') return T.send.notDue(whenHe(b.until, at));
  if (b.why === 'cap') return T.guard.cap(b.n);
  return T.guard[b.why] || b.why;
}

const graphWhy = (e) => (e instanceof GraphError && T.graph[e.code]) || T.graph.other(e.message);

// Errors that are about this one number, not about our setup: the lead is marked as not reached.
const UNDELIVERED = new Set([131026, 131049, 131050, 131030]);

let quality = { at: 0, value: null };
export const forgetQuality = () => {
  quality = { at: 0, value: null };
};

async function qualityNow(app, m) {
  if (quality.value && now() - quality.at < 10 * MINUTE) return quality.value;
  try {
    quality = { at: now(), value: await numberQuality(m, app.graphFetch) };
  } catch (e) {
    app.log(`[out] could not read the number's quality: ${e.message}`);
    return null; // Meta did not answer: the send itself will say what is wrong
  }
  return quality.value;
}

/** A message, kept with the lead. A Meta id seen before (a webhook sent twice) keeps nothing: answers false. */
function keep(db, { leadId, phone, dir, kind, body, waId = null, status = null, error = null, at = now() }) {
  const r = db.run('INSERT OR IGNORE INTO messages (lead_id, phone, dir, kind, body, wa_id, status, error, day, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', leadId, phone, dir, kind, body, waId, status, error, israelDate(at), nowIso(at));
  return r.changes > 0;
}

const RANK = { not_sent: 0, failed: 1, undelivered: 1, sent: 2, delivered: 3, read: 4, yes: 5, replied: 6 };

/** Move how far our message got forward, never back (a "delivered" can arrive after a "read"). */
function raise(db, lead, state) {
  if (lead.out_state === 'stopped') return;
  if ((RANK[state] ?? 0) > (RANK[lead.out_state] ?? 0)) {
    db.run('UPDATE leads SET out_state = ?, updated_at = ? WHERE id = ?', state, nowIso(), lead.id);
    lead.out_state = state;
  }
}

/** The first message or the reminder, from the business number, as its approved template. */
export async function sendPitch(app, lead, stage) {
  const m = metaSettings(app.env);
  if (!m.ready) return { ok: false, why: 'setup', flash: T.setup.meta };
  const b = blocked(app, lead, stage);
  if (b) return { ok: false, why: b.why, flash: blockedText(b) };
  const q = await qualityNow(app, m);
  if (q && !['GREEN', 'UNKNOWN'].includes(q)) return { ok: false, why: 'quality', flash: T.guard.quality(q) };
  const o = outreachSettings(app.env);
  const code = pageCodeOf(app.db, lead);
  const t = stage === 'first' ? await firstTemplate(app, lead) : { name: await pickTemplate(m, app.graphFetch, o.reminders), trade: false, params: [nameParam(lead)] };
  const body = messageText(stage, lead, app.env, { trade: t.trade });
  let id;
  try {
    id = await sendTemplate(m, app.graphFetch, lead.mobile, t.name, t.params, 'he', { url: code });
  } catch (e) {
    app.log(`[out] ${stage} to ${masked(lead.mobile)} (lead ${lead.id}) not sent: ${e.code || ''} ${e.message}`);
    if (e instanceof GraphError && UNDELIVERED.has(e.code)) {
      keep(app.db, { leadId: lead.id, phone: lead.mobile, dir: 'out', kind: stage, body, status: 'failed', error: graphWhy(e) });
      if (stage === 'first') app.db.run("UPDATE leads SET out_state = 'undelivered', updated_at = ? WHERE id = ?", nowIso(), lead.id);
    }
    return { ok: false, why: e instanceof GraphError && UNDELIVERED.has(e.code) ? 'undelivered' : 'failed', flash: T.send.failed(graphWhy(e)) };
  }
  const at = nowIso();
  app.db.tx(() => {
    keep(app.db, { leadId: lead.id, phone: lead.mobile, dir: 'out', kind: stage, body, waId: id || null, status: 'sent' });
    if (stage === 'first') app.db.run("UPDATE leads SET first_at = ?, out_state = 'sent', out_by = 'meta', stage = 'waiting', later_until = NULL, updated_at = ? WHERE id = ?", at, at, lead.id);
    else app.db.run('UPDATE leads SET reminder_at = ?, updated_at = ? WHERE id = ?', at, at, lead.id);
  });
  app.log(`[out] ${stage} to ${masked(lead.mobile)} (lead ${lead.id})`);
  return { ok: true, flash: stage === 'first' ? T.send.sentFirst : T.send.sentReminder };
}

/** The admin sent it from their own phone: kept the same way, with no Meta id. */
export function markByHand(app, lead, stage) {
  const b = blocked(app, lead, stage, { byHand: true });
  // Quiet hours and a reminder not yet due say when to send; once it went from the phone, it went.
  if (b && !['quiet', 'notDue'].includes(b.why)) return { ok: false, flash: blockedText(b) };
  pageCodeOf(app.db, lead);
  const at = nowIso();
  app.db.tx(() => {
    keep(app.db, { leadId: lead.id, phone: lead.mobile, dir: 'out', kind: stage, body: messageText(stage, lead, app.env, { byHand: true }), status: 'hand' });
    if (stage === 'first') app.db.run("UPDATE leads SET first_at = ?, out_state = 'sent', out_by = 'hand', stage = 'waiting', later_until = NULL, updated_at = ? WHERE id = ?", at, at, lead.id);
    else app.db.run('UPDATE leads SET reminder_at = ?, updated_at = ? WHERE id = ?', at, at, lead.id);
  });
  return { ok: true, flash: T.send.marked };
}

/** The admin's own answer, as plain text, inside the 24 hours. */
export async function reply(app, lead, text) {
  const body = String(text || '').trim().slice(0, 4000);
  if (!body) return { ok: false, flash: T.chat.empty };
  const m = metaSettings(app.env);
  if (!m.ready) return { ok: false, flash: T.setup.meta };
  if (!windowOpen(lead)) return { ok: false, flash: T.chat.closed };
  try {
    const id = await sendText(m, app.graphFetch, lead.mobile, body);
    keep(app.db, { leadId: lead.id, phone: lead.mobile, dir: 'out', kind: 'reply', body, waId: id || null, status: 'sent' });
  } catch (e) {
    app.log(`[out] reply to ${masked(lead.mobile)} (lead ${lead.id}) not sent: ${e.code || ''} ${e.message}`);
    return { ok: false, flash: T.send.failed(graphWhy(e)) };
  }
  return { ok: true, flash: T.chat.sent };
}

/** Plain text we send by ourselves after their message (the explanation, the line after a stop). */
async function answer(app, lead, kind, body) {
  const m = metaSettings(app.env);
  if (!m.ready) return;
  try {
    const id = await sendText(m, app.graphFetch, lead.mobile, body);
    keep(app.db, { leadId: lead.id, phone: lead.mobile, dir: 'out', kind, body, waId: id || null, status: 'sent' });
  } catch (e) {
    app.log(`[out] ${kind} to ${masked(lead.mobile)} (lead ${lead.id}) not sent: ${e.code || ''} ${e.message}`);
  }
}

// ---- The webhook: how far ours got, and what they wrote

const YES = /^\s*(?:כן|כן,? שלחו|כן,? תשלחו|שלחו|תשלחו|בטח|אשמח|יאללה|כן בבקשה|כן,? אשמח)\s*[.!]*\s*$/;
const NO = /^\s*לא(?:,? תודה)?\s*[.!]*\s*$/;

function onStatus(app, s) {
  const msg = app.db.get('SELECT * FROM messages WHERE wa_id = ?', s.id);
  if (!msg) return;
  const error = s.error ? (T.graph[s.error.code] || T.graph.other(s.error.title)) : null;
  // A late "sent" never overwrites a "read".
  const order = { sent: 1, delivered: 2, read: 3, failed: 3 };
  if ((order[s.status] ?? 0) >= (order[msg.status] ?? 0)) app.db.run('UPDATE messages SET status = ?, error = ? WHERE id = ?', s.status, error, msg.id);
  if (!msg.lead_id || !['first', 'reminder'].includes(msg.kind)) return;
  const lead = app.db.get('SELECT * FROM leads WHERE id = ?', msg.lead_id);
  if (!lead) return;
  if (s.status === 'failed') {
    if ((RANK[lead.out_state] ?? 0) <= RANK.sent) {
      const state = s.error && UNDELIVERED.has(s.error.code) ? 'undelivered' : 'failed';
      app.db.run('UPDATE leads SET out_state = ?, updated_at = ? WHERE id = ?', state, nowIso(), lead.id);
    }
    return;
  }
  if (['sent', 'delivered', 'read'].includes(s.status)) raise(app.db, lead, s.status);
}

async function onMessage(app, m) {
  const { db } = app;
  const from = String(m.from).replace(/\D/g, '');
  if (!from) return;
  const at = m.at && Math.abs(m.at - now()) < DAY ? m.at : now();
  if (from === ownerNumber(app.env)) return fromOwner(app, from, m, at);
  // The lead we wrote to on this number, else the newest with it.
  let lead = db.get('SELECT * FROM leads WHERE mobile = ? ORDER BY (first_at IS NULL), id DESC LIMIT 1', from);
  const customer = customerByPhone(db, from);
  if (!lead) {
    const stamp = nowIso(at);
    const id = Number(
      db.run(
        `INSERT INTO leads (name, mobile, source, detail, stage, closed_why, out_state, qualified, replied_at, last_in_at, created_at, updated_at) VALUES (?, ?, 'whatsapp', ?, ${customer ? "'closed', 'customer'" : "'talking', NULL"}, 'replied', 1, ?, ?, ?, ?)`,
        (m.name || (customer ? customer.business : local(from))).slice(0, 80),
        from,
        JSON.stringify({ first: m.text.slice(0, 300) }),
        stamp,
        stamp,
        stamp,
        stamp
      ).lastInsertRowid
    );
    lead = db.get('SELECT * FROM leads WHERE id = ?', id);
    if (customer) db.run('UPDATE customers SET lead_id = ? WHERE id = ? AND lead_id IS NULL', id, customer.id);
    app.log(`[in] a new ${customer ? 'chat with customer' : 'lead'} from ${masked(from)} (lead ${id})`);
  }
  // A business's WhatsApp also answers by itself the moment a message comes in, in words of its own (a greeting, a
  // business card): no one reads ours and types an answer within seconds ("אשל המיזוג - איך אפשר לעזור ?", one
  // second after the first message, 2026-11-25), by the time Meta gives the message. A button pressed that fast is
  // still them.
  const instant = Boolean(lead.first_at && m.at) && m.at - Date.parse(lead.first_at) < 20_000;
  const auto = m.type === 'text' && (automatic(m.text) || instant);
  if (!keep(db, { leadId: lead.id, phone: from, dir: 'in', kind: auto ? 'auto' : 'in', body: m.text, waId: m.id || null, at })) return; // seen before
  const stamp = nowIso(at);
  db.run('UPDATE leads SET last_in_at = ?, updated_at = ? WHERE id = ?', stamp, stamp, lead.id);
  if (customer && m.media) {
    let taken = true;
    try {
      taken = await takeReceipt(app, customer, m);
    } catch (e) {
      app.log(`[pay] customer ${customer.id}: ${e.stack || e}`);
    }
    if (taken) return;
  }
  const isCustomer = lead.closed_why === 'customer';

  const wroteFirst = Boolean(lead.first_at);
  const isNo = (m.type === 'button' && /^לא/.test(m.text)) || asksToStop(m.text) || (wroteFirst && !lead.yes_at && !lead.replied_at && NO.test(m.text));
  if (isNo) {
    const already = stopped(db, from);
    db.tx(() => {
      db.run('INSERT OR IGNORE INTO stops (phone, why, at) VALUES (?, ?, ?)', from, m.text.slice(0, 120), stamp);
      db.run("UPDATE leads SET stage = 'closed', closed_why = 'stopped', out_state = 'stopped', updated_at = ? WHERE mobile = ? AND coalesce(closed_why, '') != 'customer'", stamp, from);
    });
    app.log(`[in] ${masked(from)} asked us to stop (lead ${lead.id})`);
    if (!already) await answer(app, lead, 'stopped', MSG.stopped);
    return;
  }
  if (auto) return;

  // A customer writing: in a conversation again, so the admin sees it among the leads they answer, and still a
  // customer (counted as one, and never deleted with the old leads). Toran answers them too (toran.js).
  if (isCustomer) {
    db.run("UPDATE leads SET stage = 'talking', replied_at = COALESCE(replied_at, ?), later_until = NULL, updated_at = ? WHERE id = ?", stamp, stamp, lead.id);
    await queueAnswer(app, lead, m);
    return;
  }
  const isYes = (m.type === 'button' && /^כן/.test(m.text)) || (wroteFirst && !lead.yes_at && YES.test(m.text));
  if (isYes && !lead.yes_at) {
    db.run("UPDATE leads SET yes_at = ?, stage = 'talking', closed_why = NULL, later_until = NULL, updated_at = ? WHERE id = ?", stamp, stamp, lead.id);
    raise(db, lead, 'yes');
    app.log(`[in] ${masked(from)} said yes (lead ${lead.id})`);
    if (!db.get("SELECT 1 FROM messages WHERE lead_id = ? AND kind = 'pitch'", lead.id)) await answer(app, lead, 'pitch', MSG.pitch(bizOf(lead), pageUrl(app.env, pageCodeOf(db, lead))));
    await alertOwner(app, `yes:${lead.id}`, ALERT.yes(whoIs(lead.name, from)), ALERT.body.open(adminLink(app.env, `/admin/leads/${lead.id}`)), 24 * 60);
    return;
  }
  // Anything else they write is an answer: the lead is in a conversation again, unless they asked us to stop before.
  // Toran answers it (toran.js).
  const reopen = lead.stage !== 'closed' || lead.closed_why !== 'stopped';
  db.run(`UPDATE leads SET replied_at = COALESCE(replied_at, ?), ${reopen ? "stage = 'talking', closed_why = NULL, later_until = NULL," : ''} updated_at = ? WHERE id = ?`, stamp, stamp, lead.id);
  raise(db, lead, 'replied');
  // Their first answer to our message: the owner hears it with what they wrote (someone who wrote first is told by toran.js).
  if (wroteFirst && !lead.replied_at && !lead.yes_at) {
    const said = ALERT.body.said(m.text.replace(/\s+/g, ' ').trim().slice(0, 300));
    await alertOwner(app, `replied:${lead.id}`, ALERT.replied(whoIs(lead.name, from)), `${said}\n${ALERT.body.open(adminLink(app.env, `/admin/leads/${lead.id}`))}`, 24 * 60);
  }
  if (reopen) await queueAnswer(app, { ...lead, stage: 'talking' }, m);
}

/**
 * The owner writing from their own phone (OWNER_WA): kept, so the inbox shows it and their 24 hours open (alerts.js
 * then sends plain text), and never answered by the sales bot, a stop word or a receipt. The owner, 2026-11-22: "do
 * that", on the bot answering their replies to an alert as if they were a lead. "סיכום" gets the last 24 hours at once.
 */
async function fromOwner(app, owner, m, at) {
  if (!keep(app.db, { leadId: null, phone: owner, dir: 'in', kind: 'owner', body: m.text, waId: m.id || null, at })) return;
  const mm = metaSettings(app.env);
  if (!/^\s*סיכום\s*[.?]*\s*$/.test(m.text) || !mm.ready) return;
  const body = `🔔 *${DIGEST.title.replace(/^על הקו:\s*/, '')}*\n${DIGEST.text(dayCounts(app.db, app.env, at)) || DIGEST.quiet}`;
  try {
    const id = await sendText(mm, app.graphFetch, owner, body);
    keep(app.db, { leadId: null, phone: owner, dir: 'out', kind: 'alert', body, waId: id || null, status: 'sent' });
  } catch (e) {
    app.log(`[out] the summary to the owner not sent: ${e.code || ''} ${e.message}`);
  }
}

/** Meta's webhook, for both our numbers: the assistant's (service.js) and the business number (here). */
export async function onWebhook(app, body) {
  const { messages, statuses } = parseWebhook(body);
  const assist = assistSettings(app.env);
  const mine = (x) => assist.ready && x.phoneId === assist.phoneId;
  for (const s of statuses) {
    if (mine(s)) await onAssistStatus(app, s);
    else onStatus(app, s);
  }
  for (const m of messages) {
    if (mine(m)) await onAssistMessage(app, m);
    else await onMessage(app, m);
  }
  return { messages: messages.length, statuses: statuses.length };
}

/** Why a closed lead was closed, in words. */
export const closedText = (lead) => CLOSED[lead.closed_why] || lead.closed_why || '';
