import { billingOf } from './billing.js';
import { intakeTurn } from './claude.js';
import { DAY, HOUR, MINUTE, hhmm, now, nowIso } from './clock.js';
import { SVC } from './copy.js';
import { num } from './env.js';
import { local, masked, normalize } from './phones.js';
import { GraphError, assistSettings, pickTemplate, sendTemplate, sendText } from './meta.js';
import { demoMessage } from './demo.js';
import { asksToStop, automatic } from './stopWords.js';
import { callAction, telnyxSettings } from './telnyx.js';

// The service (docs/connecting.md). A customer's unanswered call is forwarded by their carrier to their own voice
// number on Telnyx, which says whose caller it is. The call ends there (with a short recording when GREETING_URL is
// set), and the caller gets a WhatsApp message at once from המוקדן, the one assistant number every customer shares (on
// Meta's Cloud API, ASSIST_PHONE_ID, beside the business number). When they answer, Claude asks what happened, where
// and how urgent, one question at a time, and the summary goes from המוקדן to the customer's own WhatsApp.
//
//   whose caller       a message to המוקדן is the customer's when it comes from the customer's own phone, else the
//                      caller's, in the chat of their latest call (7 days); anyone else gets one line on what this is
//
//   one conversation   a caller who calls again within 24 hours continues the same chat, with no second message
//   no reply           after SUMMARY_WAIT_MINUTES (20) the customer gets a note: who called, and that no answer came
//   a stalled chat     the same wait after their last message, and the summary goes with what is known
//   hidden number      nothing to write to: the customer gets a note at once
//   no WhatsApp        the first message is not delivered: the customer gets a note to call instead
//   "הסר", "די"        the number joins the customer's "לא לשלוח" list, one line says so, and the customer is told
//   the customer       writing to their own assistant: "לא לשלוח ל־05X", "לשלוח ל־05X", "לעצור", "להמשיך"
//   no Claude          the caller is thanked and what they wrote goes to the customer as it is
//   not paid           before the first payment, and after the 72 hours past the paid month (billing.js), a forwarded
//                      call gets no message; a test call from the customer's own number still answers
//
// Telnyx wants a webhook answered within 2 seconds, so the work runs after the answer (track() keeps it, the tests
// wait for it). A caller who sends three messages in a row gets one answer: a reply waits REPLY_DELAY_MS (3 s) after
// their last message, and a chat is answered one turn at a time.

/** A caller's messages in one chat that המוקדן answers; past them it sends the summary and goes quiet. */
export const CALLER_TURNS = 12;

export function serviceSettings(env) {
  return {
    caller: String(env.TEMPLATE_CALLER || 'alhakav_caller'),
    summary: String(env.TEMPLATE_SUMMARY || 'alhakav_summary'),
    // The note, the preferred first: alhakav_call_alert, reworded on 2026-11-22 after Meta made alhakav_call_note a
    // Marketing one; meta.js pickTemplate takes it once it is approved. TEMPLATE_NOTE names one, and only that one.
    notes: String(env.TEMPLATE_NOTE || '').trim() ? [String(env.TEMPLATE_NOTE).trim()] : ['alhakav_call_alert', 'alhakav_call_note'],
    greeting: String(env.GREETING_URL || '').trim(),
    wait: num(env.SUMMARY_WAIT_MINUTES, 20) * MINUTE,
    replyDelay: num(env.REPLY_DELAY_MS, 3000),
  };
}

export function serviceState() {
  return { timers: new Map(), busy: new Set(), again: new Set(), pending: new Set(), strangers: new Map() };
}

/** Work that runs after the webhook was answered. */
export function track(app, promise) {
  const p = Promise.resolve(promise).catch((e) => app.log(`[service] ${e.stack || e}`));
  app.service.pending.add(p);
  p.finally(() => app.service.pending.delete(p));
  return p;
}

/** Everything in flight, done (the tests). */
export async function settle(app) {
  while (app.service.pending.size || app.service.timers.size) {
    for (const [, t] of app.service.timers) t.fire();
    await Promise.all([...app.service.pending]);
  }
}

const customerByAssistant = (db, n) => (n ? db.get('SELECT * FROM customers WHERE assistant = ?', n) : null);
const isSkipped = (db, customerId, phone) => Boolean(db.get('SELECT 1 FROM skips WHERE customer_id = ? AND phone = ?', customerId, phone));
const chatOf = (db, id) => db.get('SELECT * FROM chats WHERE id = ?', id);
const ownerWindowOpen = (c, at = now()) => Boolean(c.owner_in_at && at - Date.parse(c.owner_in_at) < 24 * HOUR - 5 * MINUTE);

function keep(db, m) {
  const r = db.run(
    'INSERT OR IGNORE INTO chat_messages (chat_id, customer_id, peer, dir, kind, body, msg_id, status, error, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    m.chatId ?? null,
    m.customerId,
    m.peer,
    m.dir,
    m.kind,
    m.body,
    m.msgId || null,
    m.status || null,
    m.error || null,
    nowIso(m.at ?? now())
  );
  return r.changes > 0;
}

function addSkip(db, customerId, phone, why) {
  db.run('INSERT INTO skips (customer_id, phone, why, at) VALUES (?, ?, ?, ?) ON CONFLICT (customer_id, phone) DO NOTHING', customerId, phone, why, nowIso());
}

// ---- to the customer's own WhatsApp

/**
 * A message to the customer from their assistant: text while they wrote in the last 24 hours, else the template.
 * `template` is a name, or a list to pick from with `params(name)` (meta.js pickTemplate).
 */
async function toOwner(app, c, { chatId = null, kind, template, params, text }) {
  const a = assistSettings(app.env);
  try {
    if (!a.ready) throw new Error('ASSIST_PHONE_ID is not set');
    let id;
    if (ownerWindowOpen(c)) id = await sendText(a, app.graphFetch, c.phone, text);
    else {
      const name = Array.isArray(template) ? await pickTemplate(a, app.graphFetch, template) : template;
      id = await sendTemplate(a, app.graphFetch, c.phone, name, typeof params === 'function' ? params(name) : params);
    }
    keep(app.db, { chatId, customerId: c.id, peer: c.phone, dir: 'out', kind, body: text, msgId: id, status: 'sent' });
  } catch (e) {
    app.log(`[service] ${kind} to customer ${c.id} not sent: ${e.code || ''} ${e.message}`);
    keep(app.db, { chatId, customerId: c.id, peer: c.phone, dir: 'out', kind, body: text, status: 'failed', error: e.message });
  }
}

/** A short note about a call: no WhatsApp to write to, no answer yet, asked to stop, a test. */
function note(app, c, { caller, at, line, chatId = null }) {
  const number = caller ? local(caller) : SVC.hidden;
  const time = hhmm(at);
  // alhakav_call_note, the old one, says who first: "התקשרו אליכם {{1}} ב־{{2}}".
  const params = (name) => (name === 'alhakav_call_note' ? [caller ? SVC.from(local(caller)) : SVC.fromHidden, time, line] : [time, number, line]);
  return toOwner(app, c, { chatId, kind: 'note', template: serviceSettings(app.env).notes, params, text: SVC.note({ time, number, line }) });
}

/** The summary: what, where, how urgent, and the number, from what the chat holds now. */
export async function sendSummary(app, c, chat) {
  const v = {
    time: hhmm(Date.parse(chat.opened_at)),
    what: chat.what || SVC.unknown,
    place: chat.place || SVC.unknown,
    urgency: chat.urgency || SVC.unknown,
    phone: local(chat.caller),
  };
  await toOwner(app, c, { chatId: chat.id, kind: 'summary', template: serviceSettings(app.env).summary, params: [v.time, v.what, v.place, v.urgency, v.phone], text: SVC.summary(v) });
  app.db.run('UPDATE chats SET summary_at = ?, updated_at = ? WHERE id = ?', nowIso(), nowIso(), chat.id);
}

// ---- a call

export async function onCall(app, ev) {
  const { db } = app;
  const t = telnyxSettings(app.env);
  const s = serviceSettings(app.env);
  const act = (action, body) => callAction(t, app.telnyxFetch, ev.callId, action, body).catch((e) => app.log(`[call] ${action} failed: ${e.message}`));

  if (ev.type === 'call.playback.ended') return act('hangup');
  if (ev.type !== 'call.initiated' || ev.direction !== 'incoming') return;

  const c = customerByAssistant(db, ev.to);
  if (!c) return act('reject', { cause: 'CALL_REJECTED' });
  const r = db.run('INSERT OR IGNORE INTO calls (customer_id, caller, call_id, outcome, at) VALUES (?, ?, ?, ?, ?)', c.id, ev.from || null, ev.callId, 'received', nowIso());
  if (!r.changes) return; // the same event, again
  const callRow = Number(r.lastInsertRowid);
  db.run('UPDATE customers SET last_call_at = ?, updated_at = ? WHERE id = ?', nowIso(), nowIso(), c.id);

  // The call ends here: a short recording when there is one, else at once, so the caller is not left ringing.
  if (s.greeting) {
    await act('answer');
    await act('playback_start', { audio_url: s.greeting, audio_type: s.greeting.endsWith('.wav') ? 'wav' : 'mp3' });
  } else await act('reject', { cause: 'USER_BUSY' });

  const outcome = await missedCall(app, c, ev.from);
  db.run('UPDATE calls SET outcome = ?, chat_id = ? WHERE id = ?', outcome.outcome, outcome.chatId ?? null, callRow);
}

/** What a missed call turns into. Answers { outcome, chatId }. */
export async function missedCall(app, c, raw) {
  const { db } = app;
  const at = now();
  const caller = normalize(raw) || null;
  if (c.status !== 'active') return { outcome: 'inactive' };
  if (caller && caller === c.phone) {
    await note(app, c, { caller, at, line: SVC.lines.test });
    return { outcome: 'test' };
  }
  if (!billingOf(c).on) return { outcome: 'unpaid' };
  if (!caller) {
    await note(app, c, { caller: null, at, line: SVC.lines.hidden });
    return { outcome: 'hidden' };
  }
  if (isSkipped(db, c.id, caller)) return { outcome: 'skipped' };
  const open = db.get('SELECT * FROM chats WHERE customer_id = ? AND caller = ? AND opened_at > ? ORDER BY id DESC LIMIT 1', c.id, caller, nowIso(at - DAY));
  if (open) {
    db.run('UPDATE chats SET calls = calls + 1, updated_at = ? WHERE id = ?', nowIso(), open.id);
    return { outcome: 'again', chatId: open.id };
  }
  const chatId = Number(db.run('INSERT INTO chats (customer_id, caller, opened_at, updated_at) VALUES (?, ?, ?, ?)', c.id, caller, nowIso(at), nowIso(at)).lastInsertRowid);
  const body = SVC.callerFirst(c.business);
  try {
    const a = assistSettings(app.env);
    if (!a.ready) throw new Error('ASSIST_PHONE_ID is not set');
    const id = await sendTemplate(a, app.graphFetch, caller, serviceSettings(app.env).caller, [c.business]);
    keep(db, { chatId, customerId: c.id, peer: caller, dir: 'out', kind: 'first', body, msgId: id, status: 'sent' });
    db.run('UPDATE chats SET last_out_at = ? WHERE id = ?', nowIso(), chatId);
    app.log(`[call] customer ${c.id}: ${masked(caller)} got the first message`);
    return { outcome: 'messaged', chatId };
  } catch (e) {
    app.log(`[call] customer ${c.id}: first message to ${masked(caller)} not sent: ${e.code || ''} ${e.message}`);
    keep(db, { chatId, customerId: c.id, peer: caller, dir: 'out', kind: 'first', body, status: 'failed', error: e.message });
    db.run("UPDATE chats SET state = 'failed', note_at = ?, updated_at = ? WHERE id = ?", nowIso(), nowIso(), chatId);
    await note(app, c, { caller, at, chatId, line: e instanceof GraphError && NO_WHATSAPP.has(e.code) ? SVC.lines.noWhatsapp : SVC.lines.failed });
    return { outcome: 'failed', chatId };
  }
}

// ---- WhatsApp, on המוקדן's number

/** Meta's errors that mean the number has no WhatsApp, or cannot get it from us. */
const NO_WHATSAPP = new Set([131026, 131049, 131050]);

/** How far one of ours got. A first message that never arrived means no WhatsApp on that number. */
export async function onAssistStatus(app, st) {
  const { db } = app;
  const msg = st.id && db.get('SELECT * FROM chat_messages WHERE msg_id = ?', st.id);
  if (!msg) return;
  const failed = st.status === 'failed';
  const order = { sent: 1, delivered: 2, read: 3, failed: 3 };
  if ((order[st.status] ?? 0) >= (order[msg.status] ?? 0)) db.run('UPDATE chat_messages SET status = ?, error = ? WHERE id = ?', st.status, failed ? st.error?.title || 'not delivered' : null, msg.id);
  if (failed && msg.kind === 'first' && msg.chat_id) {
    const chat = chatOf(db, msg.chat_id);
    const c = db.get('SELECT * FROM customers WHERE id = ?', msg.customer_id);
    if (chat && c && chat.state === 'waiting' && !chat.note_at) {
      db.run("UPDATE chats SET state = 'failed', note_at = ?, updated_at = ? WHERE id = ?", nowIso(), nowIso(), chat.id);
      await note(app, c, { caller: chat.caller, at: Date.parse(chat.opened_at), chatId: chat.id, line: SVC.lines.noWhatsapp });
    }
  }
}

/** The customer who owns this phone, unless they are in a caller's chat right now (they called another customer). */
function ownerOf(db, phone) {
  const c = db.get("SELECT * FROM customers WHERE phone = ? ORDER BY status = 'stopped', id DESC LIMIT 1", phone);
  if (!c) return null;
  const asCaller = db.get("SELECT 1 FROM chats WHERE caller = ? AND state IN ('waiting', 'talking') AND opened_at > ?", phone, nowIso(now() - DAY));
  return asCaller ? null : c;
}

/** Someone wrote to המוקדן: the customer, a caller in their latest call's chat, or someone it does not know. */
export async function onAssistMessage(app, m) {
  const { db } = app;
  const from = String(m.from || '').replace(/\D/g, '');
  if (!from) return;
  // A try of המוקדן from a lead's page (demo.js): a page's code starts one, and its turns follow.
  if (await demoMessage(app, from, m)) return;
  const text = String(m.text || '').trim();
  const owner = ownerOf(db, from);
  if (owner) return fromOwner(app, owner, m, text);

  const chat = db.get('SELECT * FROM chats WHERE caller = ? AND opened_at > ? ORDER BY COALESCE(last_in_at, last_out_at, opened_at) DESC, id DESC LIMIT 1', from, nowIso(now() - 7 * DAY));
  if (!chat) return stranger(app, from);
  const c = db.get('SELECT * FROM customers WHERE id = ?', chat.customer_id);
  if (!c) return;
  const auto = automatic(text);
  if (!keep(db, { chatId: chat.id, customerId: c.id, peer: from, dir: 'in', kind: auto ? 'auto' : 'in', body: text, msgId: m.id })) return; // seen before
  db.run('UPDATE chats SET last_in_at = ?, updated_at = ? WHERE id = ?', nowIso(), nowIso(), chat.id);

  if (asksToStop(text) || (m.type === 'button' && /^לא/.test(text))) {
    addSkip(db, c.id, from, 'stopped');
    db.run("UPDATE chats SET state = 'stopped', updated_at = ? WHERE id = ?", nowIso(), chat.id);
    try {
      const id = await sendText(assistSettings(app.env), app.graphFetch, from, SVC.callerStopped);
      keep(db, { chatId: chat.id, customerId: c.id, peer: from, dir: 'out', kind: 'stopped', body: SVC.callerStopped, msgId: id, status: 'sent' });
    } catch (e) {
      app.log(`[chat] stop line to ${masked(from)} not sent: ${e.message}`);
    }
    if (!chat.summary_at) await note(app, c, { caller: from, at: Date.parse(chat.opened_at), chatId: chat.id, line: SVC.lines.stopped });
    return;
  }
  if (auto || isSkipped(db, c.id, from) || c.status !== 'active') return;
  if (chat.state === 'waiting' || chat.state === 'failed') db.run("UPDATE chats SET state = 'talking' WHERE id = ?", chat.id);
  schedule(app, chat.id);
}

/** Someone who neither called a customer lately nor is one: one line on what this number is, once a day. */
async function stranger(app, from) {
  const seen = app.service.strangers;
  const last = seen.get(from);
  if (last && now() - last < DAY) return;
  seen.set(from, now());
  try {
    await sendText(assistSettings(app.env), app.graphFetch, from, SVC.stranger(String(app.env.SITE_URL || '').trim()));
    app.log(`[chat] ${masked(from)} wrote to המוקדן with no call: told what it is`);
  } catch (e) {
    app.log(`[chat] line to ${masked(from)} not sent: ${e.message}`);
  }
}

/** Answer a chat a moment after its last message, so a caller writing in three parts gets one answer. */
function schedule(app, chatId) {
  const s = app.service;
  const old = s.timers.get(chatId);
  if (old) {
    clearTimeout(old.timer);
    old.resolve();
  }
  let resolve;
  const done = new Promise((r) => (resolve = r));
  const fire = () => {
    clearTimeout(entry.timer);
    s.timers.delete(chatId);
    track(app, answer(app, chatId)).finally(resolve);
  };
  const entry = { timer: setTimeout(fire, serviceSettings(app.env).replyDelay), resolve, fire };
  s.timers.set(chatId, entry);
  track(app, done);
}

async function answer(app, chatId) {
  const s = app.service;
  if (s.busy.has(chatId)) {
    s.again.add(chatId);
    return;
  }
  s.busy.add(chatId);
  try {
    await turn(app, chatId);
  } finally {
    s.busy.delete(chatId);
    if (s.again.delete(chatId)) await answer(app, chatId);
  }
}

async function turn(app, chatId) {
  const { db } = app;
  const chat = chatOf(db, chatId);
  if (!chat || chat.state === 'stopped') return;
  const c = db.get('SELECT * FROM customers WHERE id = ?', chat.customer_id);
  const messages = db.all("SELECT dir, body FROM chat_messages WHERE chat_id = ? AND kind != 'auto' AND peer = ? ORDER BY at, id", chat.id, chat.caller);
  // Past CALLER_TURNS of their messages, המוקדן stops answering: the summary goes with what it has, once, and no more
  // Claude for this chat, so a caller cannot keep it talking (or run up the bill).
  if (messages.filter((m) => m.dir === 'in').length > CALLER_TURNS) {
    if (!chat.summary_at && c) await sendSummary(app, c, chat);
    db.run("UPDATE chats SET state = 'done', updated_at = ? WHERE id = ?", nowIso(), chat.id);
    return;
  }
  let next;
  if (app.claude) {
    try {
      next = await intakeTurn(app.claude, c, messages);
      if (next.cut?.length) app.log(`[chat] ${chat.id}: the guard cut ${next.cut.join(', ')} from: ${String(next.raw).slice(0, 200)}`);
    } catch (e) {
      app.log(`[chat] ${chat.id}: Claude: ${e.message}`);
    }
  }
  if (!next) {
    // No Claude, or no usable answer: thank them, and pass on what they wrote as it is.
    const said = messages.filter((m) => m.dir === 'in').map((m) => m.body).join(' / ');
    next = { reply: SVC.callerThanks(c.business), done: true, what: said.slice(0, 300), place: chat.place, urgency: chat.urgency };
  }
  try {
    const id = await sendText(assistSettings(app.env), app.graphFetch, chat.caller, next.reply);
    keep(db, { chatId: chat.id, customerId: c.id, peer: chat.caller, dir: 'out', kind: 'reply', body: next.reply, msgId: id, status: 'sent' });
  } catch (e) {
    app.log(`[chat] ${chat.id}: reply not sent: ${e.message}`);
  }
  db.run(
    'UPDATE chats SET what = ?, place = ?, urgency = ?, state = ?, last_out_at = ?, updated_at = ? WHERE id = ?',
    next.what || chat.what,
    next.place || chat.place,
    next.urgency || chat.urgency,
    next.done ? 'done' : 'talking',
    nowIso(),
    nowIso(),
    chat.id
  );
  if (next.done) await sendSummary(app, c, chatOf(db, chat.id));
}

/** The customer writing to their own assistant: a few words it understands, and what it is otherwise. */
async function fromOwner(app, c, m, text) {
  const { db } = app;
  if (!keep(db, { customerId: c.id, peer: c.phone, dir: 'in', kind: 'owner', body: text, msgId: m.id })) return;
  db.run('UPDATE customers SET owner_in_at = ?, updated_at = ? WHERE id = ?', nowIso(), nowIso(), c.id);
  const number = normalize((/(\+?[\d][\d\s-]{7,15}\d)/.exec(text) || [])[1]);
  let reply;
  if (number && /^(?:לא לשלוח|אל תשלח|אל תשלחו|לא לכתוב|תפסיק לשלוח)/.test(text)) {
    addSkip(db, c.id, number, 'owner');
    reply = SVC.owner.skipped(local(number));
  } else if (number && /^(?:לשלוח|כן לשלוח|להחזיר)/.test(text)) {
    db.run('DELETE FROM skips WHERE customer_id = ? AND phone = ?', c.id, number);
    reply = SVC.owner.unskipped(local(number));
  } else if (/^(?:לעצור|עצור|הפסקה|להפסיק)/.test(text) && c.status === 'active') {
    db.run("UPDATE customers SET status = 'paused', updated_at = ? WHERE id = ?", nowIso(), c.id);
    reply = SVC.owner.paused;
  } else if (/^(?:להמשיך|המשך|להפעיל)/.test(text) && c.status === 'paused') {
    db.run("UPDATE customers SET status = 'active', updated_at = ? WHERE id = ?", nowIso(), c.id);
    reply = SVC.owner.resumed;
  } else reply = SVC.owner.help(c.business);
  try {
    const id = await sendText(assistSettings(app.env), app.graphFetch, c.phone, reply);
    keep(db, { customerId: c.id, peer: c.phone, dir: 'out', kind: 'owner', body: reply, msgId: id, status: 'sent' });
  } catch (e) {
    app.log(`[owner] customer ${c.id}: reply not sent: ${e.message}`);
  }
}

// ---- once a minute

/**
 * The notes and summaries that wait for time: a first message with no answer after the wait, and a chat that stopped
 * midway. Then the privacy policy's lengths: callers' chats, calls and messages 90 days, and 30 days after a customer
 * stopped (privacy.html#p-keep).
 */
export async function serviceTick(app, at = now()) {
  const { db } = app;
  const wait = serviceSettings(app.env).wait;
  const before = nowIso(at - wait);
  for (const chat of db.all("SELECT * FROM chats WHERE state = 'waiting' AND note_at IS NULL AND opened_at < ?", before)) {
    const c = db.get('SELECT * FROM customers WHERE id = ?', chat.customer_id);
    db.run('UPDATE chats SET note_at = ? WHERE id = ?', nowIso(at), chat.id);
    if (c) await note(app, c, { caller: chat.caller, at: Date.parse(chat.opened_at), chatId: chat.id, line: SVC.lines.noReply });
  }
  for (const chat of db.all("SELECT * FROM chats WHERE state = 'talking' AND summary_at IS NULL AND last_in_at < ?", before)) {
    const c = db.get('SELECT * FROM customers WHERE id = ?', chat.customer_id);
    if (c && !app.service.busy.has(chat.id) && !app.service.timers.has(chat.id)) await sendSummary(app, c, chat);
  }
  const old = nowIso(at - 90 * DAY);
  db.run('DELETE FROM chats WHERE opened_at < ?', old);
  db.run('DELETE FROM calls WHERE at < ?', old);
  db.run('DELETE FROM chat_messages WHERE at < ?', old);
  const gone = nowIso(at - 30 * DAY);
  for (const c of db.all("SELECT id FROM customers WHERE status = 'stopped' AND stopped_at < ?", gone)) {
    db.run('DELETE FROM chats WHERE customer_id = ?', c.id);
    db.run('DELETE FROM calls WHERE customer_id = ?', c.id);
    db.run('DELETE FROM chat_messages WHERE customer_id = ?', c.id);
  }
}
