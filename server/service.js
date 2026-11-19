import { intakeTurn } from './claude.js';
import { DAY, HOUR, MINUTE, hhmm, now, nowIso } from './clock.js';
import { SVC } from './copy.js';
import { num } from './env.js';
import { isMobile, local, masked, normalize } from './phones.js';
import { asksToStop, automatic } from './stopWords.js';
import { TelnyxError, callAction, sendTemplate, sendText, telnyxSettings } from './telnyx.js';

// The service (docs/connecting.md). A customer's unanswered call is forwarded by their carrier to their assistant
// number on Telnyx. The call ends there (with a short recording when GREETING_URL is set), and the caller gets a
// WhatsApp message from the assistant number at once. When they answer, Claude asks what happened, where and how
// urgent, one question at a time, and the summary goes from the assistant number to the customer's own WhatsApp.
//
//   one conversation   a caller who calls again within 24 hours continues the same chat, with no second message
//   no reply           after SUMMARY_WAIT_MINUTES (20) the customer gets a note: who called, and that no answer came
//   a stalled chat     the same wait after their last message, and the summary goes with what is known
//   hidden number      nothing to write to: the customer gets a note at once
//   no WhatsApp        the first message is not delivered: the customer gets a note to call instead
//   "הסר", "די"        the number joins the customer's "לא לשלוח" list, one line says so, and the customer is told
//   the customer       writing to their own assistant: "לא לשלוח ל־05X", "לשלוח ל־05X", "לעצור", "להמשיך"
//   no Claude          the caller is thanked and what they wrote goes to the customer as it is
//
// Telnyx wants a webhook answered within 2 seconds, so the work runs after the answer (track() keeps it, the tests
// wait for it). A caller who sends three messages in a row gets one answer: a reply waits REPLY_DELAY_MS (3 s) after
// their last message, and a chat is answered one turn at a time.

export function serviceSettings(env) {
  return {
    caller: String(env.TEMPLATE_CALLER || 'alhakav_caller'),
    summary: String(env.TEMPLATE_SUMMARY || 'alhakav_summary'),
    note: String(env.TEMPLATE_NOTE || 'alhakav_call_note'),
    greeting: String(env.GREETING_URL || '').trim(),
    wait: num(env.SUMMARY_WAIT_MINUTES, 20) * MINUTE,
    replyDelay: num(env.REPLY_DELAY_MS, 3000),
  };
}

export function serviceState() {
  return { timers: new Map(), busy: new Set(), again: new Set(), pending: new Set() };
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

/** A message to the customer from their assistant: text while they wrote in the last 24 hours, else the template. */
async function toOwner(app, c, { chatId = null, kind, template, params, text }) {
  const t = telnyxSettings(app.env);
  try {
    const id = ownerWindowOpen(c) ? await sendText(t, app.telnyxFetch, c.assistant, c.phone, text) : await sendTemplate(t, app.telnyxFetch, c.assistant, c.phone, template, params);
    keep(app.db, { chatId, customerId: c.id, peer: c.phone, dir: 'out', kind, body: text, msgId: id, status: 'sent' });
  } catch (e) {
    app.log(`[service] ${kind} to customer ${c.id} not sent: ${e.code || ''} ${e.message}`);
    keep(app.db, { chatId, customerId: c.id, peer: c.phone, dir: 'out', kind, body: text, status: 'failed', error: e.message });
  }
}

/** A short note about a call: no WhatsApp to write to, no answer yet, asked to stop, a test. */
function note(app, c, { caller, at, line, chatId = null }) {
  const from = caller ? SVC.from(local(caller)) : SVC.fromHidden;
  const time = hhmm(at);
  return toOwner(app, c, { chatId, kind: 'note', template: serviceSettings(app.env).note, params: [from, time, line], text: SVC.note({ from, time, line }) });
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
  if (ev.type === 'call.recording.saved') {
    const c = customerByAssistant(db, ev.to);
    if (c && ev.recording) db.run('UPDATE customers SET otp_recording = ?, otp_at = ?, updated_at = ? WHERE id = ?', ev.recording, nowIso(), nowIso(), c.id);
    return;
  }
  if (ev.type !== 'call.initiated' || ev.direction !== 'incoming') return;

  const c = customerByAssistant(db, ev.to);
  if (!c) return act('reject', { cause: 'CALL_REJECTED' });
  // A number being registered on WhatsApp: Meta calls it to read the code aloud, and the call is recorded for the admin.
  if (c.wa_status === 'verifying') {
    db.run("INSERT OR IGNORE INTO calls (customer_id, caller, call_id, outcome, at) VALUES (?, ?, ?, 'otp', ?)", c.id, ev.from || null, ev.callId, nowIso());
    await act('answer');
    return act('record_start', { format: 'mp3', channels: 'single' });
  }
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
  if (!caller) {
    await note(app, c, { caller: null, at, line: SVC.lines.hidden });
    return { outcome: 'hidden' };
  }
  if (caller === c.phone) {
    await note(app, c, { caller, at, line: SVC.lines.test });
    return { outcome: 'test' };
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
    const id = await sendTemplate(telnyxSettings(app.env), app.telnyxFetch, c.assistant, caller, serviceSettings(app.env).caller, [c.business]);
    keep(db, { chatId, customerId: c.id, peer: caller, dir: 'out', kind: 'first', body, msgId: id, status: 'sent' });
    db.run('UPDATE chats SET last_out_at = ? WHERE id = ?', nowIso(), chatId);
    app.log(`[call] customer ${c.id}: ${masked(caller)} got the first message`);
    return { outcome: 'messaged', chatId };
  } catch (e) {
    app.log(`[call] customer ${c.id}: first message to ${masked(caller)} not sent: ${e.code || ''} ${e.message}`);
    keep(db, { chatId, customerId: c.id, peer: caller, dir: 'out', kind: 'first', body, status: 'failed', error: e.message });
    db.run("UPDATE chats SET state = 'failed', note_at = ?, updated_at = ? WHERE id = ?", nowIso(), nowIso(), chatId);
    await note(app, c, { caller, at, chatId, line: e instanceof TelnyxError && e.status < 500 && !isMobile(caller) ? SVC.lines.noWhatsapp : SVC.lines.failed });
    return { outcome: 'failed', chatId };
  }
}

// ---- WhatsApp

export async function onWhatsApp(app, ev) {
  const { db } = app;
  if (ev.type === 'message.received') return received(app, ev);
  // How far ours got. A first message that never arrived means no WhatsApp on that number.
  const msg = ev.id && db.get('SELECT * FROM chat_messages WHERE msg_id = ?', ev.id);
  if (!msg) return;
  const failed = /fail/.test(ev.status) || (ev.type === 'message.finalized' && ev.error);
  const status = failed ? 'failed' : ev.type === 'message.read' ? 'read' : ev.status === 'delivered' || ev.type === 'message.finalized' ? 'delivered' : 'sent';
  const order = { sent: 1, delivered: 2, read: 3, failed: 3 };
  if ((order[status] ?? 0) >= (order[msg.status] ?? 0)) db.run('UPDATE chat_messages SET status = ?, error = ? WHERE id = ?', status, failed ? ev.error || 'not delivered' : null, msg.id);
  if (failed && msg.kind === 'first' && msg.chat_id) {
    const chat = chatOf(db, msg.chat_id);
    const c = db.get('SELECT * FROM customers WHERE id = ?', msg.customer_id);
    if (chat && c && chat.state === 'waiting' && !chat.note_at) {
      db.run("UPDATE chats SET state = 'failed', note_at = ?, updated_at = ? WHERE id = ?", nowIso(), nowIso(), chat.id);
      await note(app, c, { caller: chat.caller, at: Date.parse(chat.opened_at), chatId: chat.id, line: SVC.lines.noWhatsapp });
    }
  }
}

async function received(app, ev) {
  const { db } = app;
  const c = customerByAssistant(db, ev.to);
  if (!c || !ev.from) return;
  const text = String(ev.text || '').trim();
  if (ev.from === c.phone) return fromOwner(app, c, ev, text);

  const caller = ev.from;
  let chat = db.get('SELECT * FROM chats WHERE customer_id = ? AND caller = ? AND opened_at > ? ORDER BY id DESC LIMIT 1', c.id, caller, nowIso(now() - 7 * DAY));
  if (!chat) {
    // Someone writing first, to a number they saved: a conversation like any other.
    const id = Number(db.run("INSERT INTO chats (customer_id, caller, state, calls, opened_at, updated_at) VALUES (?, ?, 'talking', 0, ?, ?)", c.id, caller, nowIso(), nowIso()).lastInsertRowid);
    chat = chatOf(db, id);
  }
  const auto = automatic(text);
  if (!keep(db, { chatId: chat.id, customerId: c.id, peer: caller, dir: 'in', kind: auto ? 'auto' : 'in', body: text, msgId: ev.id })) return; // seen before
  db.run('UPDATE chats SET last_in_at = ?, updated_at = ? WHERE id = ?', nowIso(), nowIso(), chat.id);

  if (asksToStop(text) || (ev.button && /^לא/.test(text))) {
    addSkip(db, c.id, caller, 'stopped');
    db.run("UPDATE chats SET state = 'stopped', updated_at = ? WHERE id = ?", nowIso(), chat.id);
    try {
      const id = await sendText(telnyxSettings(app.env), app.telnyxFetch, c.assistant, caller, SVC.callerStopped);
      keep(db, { chatId: chat.id, customerId: c.id, peer: caller, dir: 'out', kind: 'stopped', body: SVC.callerStopped, msgId: id, status: 'sent' });
    } catch (e) {
      app.log(`[chat] stop line to ${masked(caller)} not sent: ${e.message}`);
    }
    if (!chat.summary_at) await note(app, c, { caller, at: Date.parse(chat.opened_at), chatId: chat.id, line: SVC.lines.stopped });
    return;
  }
  if (auto || isSkipped(db, c.id, caller) || c.status !== 'active') return;
  if (chat.state === 'waiting' || chat.state === 'failed') db.run("UPDATE chats SET state = 'talking' WHERE id = ?", chat.id);
  schedule(app, chat.id);
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
  let next;
  if (app.claude) {
    try {
      next = await intakeTurn(app.claude, c, messages);
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
    const id = await sendText(telnyxSettings(app.env), app.telnyxFetch, c.assistant, chat.caller, next.reply);
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
async function fromOwner(app, c, ev, text) {
  const { db } = app;
  if (!keep(db, { customerId: c.id, peer: c.phone, dir: 'in', kind: 'owner', body: text, msgId: ev.id })) return;
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
    const id = await sendText(telnyxSettings(app.env), app.telnyxFetch, c.assistant, c.phone, reply);
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
