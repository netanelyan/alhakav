import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { afterEach, beforeEach, test } from 'node:test';
import { handler } from '../server/app.js';
import { MINUTE, setNow } from '../server/clock.js';
import { createCustomer, customerFromLead, forwardCodes } from '../server/customers.js';
import { onWebhook } from '../server/outreach.js';
import { onCall, serviceTick, settle } from '../server/service.js';
import { readEvent, signatureOk } from '../server/telnyx.js';
import { ENV, addLead, hook, testApp } from './helpers.js';

const SUNDAY = Date.parse('2026-11-22T08:41:00Z'); // 10:41 in Israel
const OWNER = '972541112222';
const VOICE = '972771234567'; // the customer's own number at Telnyx, where their calls are forwarded
const CALLER = '972527654321';
const ASSIST = '456'; // המוקדן's Meta id

/** Telnyx, faked, for the calls: every action answers ok. */
function fakeTelnyx() {
  const t = { calls: [] };
  t.f = async (url, init = {}) => {
    t.calls.push({ url: String(url), method: init.method, body: init.body ? JSON.parse(init.body) : null });
    return Response.json({ data: {} });
  };
  t.actions = () => t.calls.filter((c) => c.url.includes('/actions/')).map((c) => c.url.split('/actions/')[1]);
  return t;
}

/** Claude, faked: answers the scripted turns in order, and keeps what it was sent. */
function fakeClaude(turns) {
  const seen = [];
  return {
    seen,
    model: 'claude-sonnet-5-5',
    messages: {
      create: async (req) => {
        seen.push(req);
        const next = turns.shift();
        if (next instanceof Error) throw next;
        return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(next) }] };
      },
    },
  };
}

const TENV = { ...ENV, TELNYX_API_KEY: 'key', TELNYX_PUBLIC_KEY: 'pk', TELNYX_API: 'https://telnyx.test/v2', ASSIST_PHONE_ID: ASSIST, ASSIST_NUMBER: '972501110000', REPLY_DELAY_MS: '0' };

function setup({ claude = null, env = TENV } = {}) {
  const tx = fakeTelnyx();
  const ctx = testApp({ env });
  ctx.app.telnyxFetch = tx.f;
  ctx.app.claude = claude;
  const r = createCustomer(ctx.db, { name: 'אבי כהן', business: 'אבי אינסטלציה', trade: 'plumber', phone: '054-111-2222', assistant: '077-123-4567' });
  assert.ok(r.ok, r.flash);
  ctx.db.run("UPDATE customers SET status = 'active', paid_until = '2026-12-21' WHERE id = ?", r.id);
  // What המוקדן sent, as Meta got it.
  const sent = () => ctx.graph.sent().filter((c) => c.url.endsWith(`/${ASSIST}/messages`)).map((c) => c.body);
  return { ...ctx, tx, cid: r.id, sent };
}

const call = (from, id = 'call-1', to = VOICE) => ({ kind: 'call', type: 'call.initiated', callId: id, from, to, direction: 'incoming' });
/** Someone writing to המוקדן's number. */
const said = (app, text, id, from = CALLER) => onWebhook(app, hook({ phoneId: ASSIST, messages: [{ id, from, type: 'text', text: { body: text } }] }));
const chats = (db) => db.all('SELECT * FROM chats ORDER BY id');

beforeEach(() => setNow(SUNDAY));
afterEach(() => setNow(null));

test('a missed call: the call ends at once, and the caller gets the first message from המוקדן', async () => {
  const { app, db, tx, sent } = setup();
  await onCall(app, call(CALLER));
  assert.deepEqual(tx.actions(), ['reject']);
  const [m] = sent();
  assert.equal(m.to, CALLER);
  assert.equal(m.template.name, 'alhakav_caller_v2');
  assert.deepEqual(m.template.components[0].parameters, [{ type: 'text', text: 'אבי אינסטלציה' }]);
  assert.equal(db.get('SELECT outcome FROM calls').outcome, 'messaged');
  // Telnyx hands the same call over again two seconds later, with an id of its own: ended, and nothing more.
  setNow(SUNDAY + 2000);
  await onCall(app, call(CALLER, 'call-1b'));
  assert.deepEqual(tx.actions(), ['reject', 'reject']);
  assert.equal(db.get('SELECT count(*) AS n FROM calls').n, 1);
  assert.equal(chats(db)[0].calls, 1);
  // The same caller again within 24 hours: the same conversation, no second message.
  setNow(SUNDAY + 5 * MINUTE);
  await onCall(app, call(CALLER, 'call-2'));
  assert.equal(sent().length, 1);
  assert.equal(chats(db)[0].calls, 2);
  // The same event twice is one call.
  await onCall(app, call(CALLER, 'call-2'));
  assert.equal(db.get('SELECT count(*) AS n FROM calls').n, 2);
});

test('with a greeting, the call is answered, plays it, and hangs up when it ends', async () => {
  const { app, tx } = setup({ env: { ...TENV, GREETING_URL: 'https://alhakav.test/greeting.mp3' } });
  await onCall(app, call(CALLER));
  await onCall(app, { kind: 'call', type: 'call.playback.ended', callId: 'call-1' });
  assert.deepEqual(tx.actions(), ['answer', 'playback_start', 'hangup']);
  assert.equal(tx.calls.find((c) => c.url.endsWith('playback_start')).body.audio_url, 'https://alhakav.test/greeting.mp3');
});

test('the conversation: Claude asks, the caller answers, and the summary reaches the customer', async () => {
  const claude = fakeClaude([
    { reply: 'מה הכתובת?', done: false, what: 'נזילה חזקה מתחת לכיור', place: '', urgency: '' },
    { reply: 'תודה, הפרטים אצל אבי אינסטלציה והם יחזרו אליך כשיתפנו.', done: true, what: 'נזילה חזקה מתחת לכיור', place: 'הרצל 15, אשדוד, קומה 3', urgency: 'דחוף, המים זורמים' },
  ]);
  const { app, db, sent } = setup({ claude });
  await onCall(app, call(CALLER));
  await said(app, 'יש לי נזילה במטבח מתחת לכיור', 'in-1');
  await settle(app);
  await said(app, 'הרצל 15 אשדוד קומה 3, זורם חזק', 'in-2');
  await settle(app);
  // Claude saw the whole chat, with the first message, and the business's name in the system prompt.
  assert.match(claude.seen[1].messages[0].content, /העוזר: 👋 שלום, כאן העוזר של אבי אינסטלציה/);
  assert.match(claude.seen[1].messages[0].content, /הלקוח: הרצל 15 אשדוד/);
  assert.match(claude.seen[0].system[0].text, /"אבי אינסטלציה"/);
  const out = sent();
  assert.equal(out[1].text.body, 'מה הכתובת?');
  const summary = out.at(-1);
  assert.equal(summary.to, OWNER);
  assert.equal(summary.template.name, 'alhakav_summary_v2');
  assert.deepEqual(
    summary.template.components[0].parameters.map((p) => p.text),
    ['10:41', 'נזילה חזקה מתחת לכיור', 'הרצל 15, אשדוד, קומה 3', 'דחוף, המים זורמים', '052-765-4321']
  );
  assert.equal(chats(db)[0].state, 'done');
});

test('after the summary, a question sends nothing more to the customer; a detail the caller adds sends it again', async () => {
  const done = { done: true, what: 'נזילה מתחת לכיור', place: 'הרצל 15, אשדוד', urgency: 'דחוף' };
  const claude = fakeClaude([
    { reply: 'תודה, הפרטים אצל אבי אינסטלציה והם יחזרו אליך כשיתפנו.', ...done },
    { reply: 'את המחיר אבי אינסטלציה יסגרו איתך כשיחזרו אליך.', ...done },
    { reply: 'תודה, הוספנו.', ...done, place: 'הרצל 15, אשדוד, קומה 3' },
  ]);
  const { app, sent } = setup({ claude });
  const toOwner = () => sent().filter((m) => m.to === OWNER);
  await onCall(app, call(CALLER));
  await said(app, 'נזילה מתחת לכיור, הרצל 15 אשדוד, דחוף', 'in-1');
  await settle(app);
  assert.equal(toOwner().length, 1);
  await said(app, 'כמה זה עולה?', 'in-2');
  await settle(app);
  assert.equal(sent().at(-1).text.body, 'את המחיר אבי אינסטלציה יסגרו איתך כשיחזרו אליך.');
  assert.equal(toOwner().length, 1, 'the same summary is not sent again');
  await said(app, 'שכחתי, קומה 3', 'in-3');
  await settle(app);
  assert.equal(toOwner().length, 2);
  assert.equal(toOwner()[1].template.components[0].parameters[2].text, 'הרצל 15, אשדוד, קומה 3');
});

test('three messages in a row get one answer', async () => {
  const claude = fakeClaude([{ reply: 'ובאיזו כתובת?', done: false, what: 'סתימה', place: '', urgency: '' }]);
  const { app, sent } = setup({ claude, env: { ...TENV, REPLY_DELAY_MS: '50' } });
  await onCall(app, call(CALLER));
  await said(app, 'היי', 'a');
  await said(app, 'יש סתימה', 'b');
  await said(app, 'בשירותים', 'c');
  await settle(app);
  assert.equal(claude.seen.length, 1);
  assert.equal(sent().filter((m) => m.type === 'text').length, 1);
});

test('without Claude, the caller is thanked and what they wrote goes to the customer as it is', async () => {
  const { app, sent } = setup();
  await onCall(app, call(CALLER));
  await said(app, 'ננעלתי בחוץ, הרא״ה 101 רמת גן', 'x');
  await settle(app);
  const [, thanks, summary] = sent();
  assert.match(thanks.text.body, /תודה, הפרטים אצל אבי אינסטלציה/);
  assert.equal(summary.template.components[0].parameters[1].text, 'ננעלתי בחוץ, הרא״ה 101 רמת גן');
});

test('"הסר" puts the caller on the list, says so once, and tells the customer', async () => {
  const { app, db, sent } = setup();
  await onCall(app, call(CALLER));
  await said(app, 'הסר', 'stop-1');
  await settle(app);
  assert.ok(db.get('SELECT 1 FROM skips WHERE phone = ?', CALLER));
  const out = sent();
  assert.equal(out[1].text.body, '✅ הסרנו את המספר, ולא נכתוב שוב.');
  assert.equal(out[2].template.name, 'alhakav_call_alert_v2');
  // They call again: nothing goes to them.
  setNow(SUNDAY + 2 * 24 * 60 * MINUTE);
  await onCall(app, call(CALLER, 'call-9'));
  assert.equal(sent().length, 3);
  assert.equal(db.get("SELECT outcome FROM calls WHERE call_id = 'call-9'").outcome, 'skipped');
});

test('a hidden number, a test call from the customer, and a first message that never arrives', async () => {
  const { app, db, sent } = setup();
  await onCall(app, call('', 'hidden'));
  let note = sent().at(-1);
  assert.equal(note.template.name, 'alhakav_call_alert_v2');
  assert.deepEqual(note.template.components[0].parameters.map((p) => p.text).slice(1), ['חסוי', 'המספר חסוי, אז אי אפשר לכתוב אליו.']);
  await onCall(app, call(OWNER, 'test'));
  assert.match(sent().at(-1).template.components[0].parameters[2].text, /שיחת בדיקה/);
  const notes = sent().length;
  await onCall(app, call(OWNER, 'test-again'));
  assert.equal(sent().length, notes, 'the same test call handed over twice is one note');
  await onCall(app, call(CALLER, 'c3'));
  const first = db.get("SELECT msg_id FROM chat_messages WHERE kind = 'first'").msg_id;
  await onWebhook(app, hook({ phoneId: ASSIST, statuses: [{ id: first, status: 'failed', recipient_id: CALLER, errors: [{ code: 131026, title: 'Message undeliverable' }] }] }));
  note = sent().at(-1);
  assert.match(note.template.components[0].parameters[2].text, /אין וואטסאפ/);
  assert.equal(chats(db)[0].state, 'failed');
});

test('no answer after 20 minutes: the customer gets a note; a stalled chat gets the summary it has', async () => {
  const claude = fakeClaude([{ reply: 'מה הכתובת?', done: false, what: 'מזגן מטפטף', place: '', urgency: '' }]);
  const { app, db, sent } = setup({ claude });
  await onCall(app, call(CALLER));
  await onCall(app, call('972501231234', 'c2'));
  await said(app, 'המזגן מטפטף', 'm1', '972501231234');
  await settle(app);
  setNow(SUNDAY + 21 * MINUTE);
  await serviceTick(app);
  const toOwner = sent().filter((m) => m.to === OWNER);
  assert.equal(toOwner.length, 2);
  assert.match(toOwner[0].template.components[0].parameters[2].text, /עוד אין תשובה/);
  assert.equal(toOwner[1].template.name, 'alhakav_summary_v2');
  assert.equal(toOwner[1].template.components[0].parameters[1].text, 'מזגן מטפטף');
  await serviceTick(app);
  assert.equal(sent().filter((m) => m.to === OWNER).length, 2, 'each goes once');
  // 90 days on, the callers' chats are gone.
  setNow(SUNDAY + 91 * 24 * 60 * MINUTE);
  await serviceTick(app);
  assert.equal(chats(db).length, 0);
});

test('the customer writes to המוקדן: the "לא לשלוח" list, a pause, and texts inside the 24 hours', async () => {
  const { app, db, sent } = setup();
  await said(app, 'לא לשלוח ל 050-999-8877', 'o1', OWNER);
  assert.ok(db.get("SELECT 1 FROM skips WHERE phone = '972509998877' AND why = 'owner'"));
  assert.match(sent().at(-1).text.body, /050-999-8877 לא יקבל/);
  await onCall(app, call('972509998877', 'mom'));
  assert.equal(db.get("SELECT outcome FROM calls WHERE call_id = 'mom'").outcome, 'skipped');
  // The owner wrote in the last 24 hours, so a note goes as text, not a template.
  await onCall(app, call('', 'h'));
  assert.equal(sent().at(-1).type, 'text');
  await said(app, 'לעצור', 'o2', OWNER);
  assert.equal(db.get('SELECT status FROM customers').status, 'paused');
  await onCall(app, call(CALLER, 'while-paused'));
  assert.equal(db.get("SELECT outcome FROM calls WHERE call_id = 'while-paused'").outcome, 'inactive');
  await said(app, 'להמשיך', 'o3', OWNER);
  assert.equal(db.get('SELECT status FROM customers').status, 'active');
});

test('two customers share המוקדן: a caller is answered in the chat of their latest call; a stranger gets one line a day', async () => {
  const claude = fakeClaude([{ reply: 'איפה בדיוק?', done: false, what: 'קצר בחשמל', place: '', urgency: '' }]);
  const { app, db, sent } = setup({ claude });
  const r = createCustomer(db, { name: 'רון', business: 'רון חשמל', trade: 'electrician', phone: '052-333-4444', assistant: '077-999-0000' });
  db.run("UPDATE customers SET status = 'active', paid_until = '2026-12-21' WHERE id = ?", r.id);
  await onCall(app, call(CALLER, 'to-avi'));
  setNow(SUNDAY + 5 * MINUTE);
  await onCall(app, call(CALLER, 'to-ron', '972779990000'));
  assert.deepEqual(sent().filter((m) => m.to === CALLER).map((m) => m.template.components[0].parameters[0].text), ['אבי אינסטלציה', 'רון חשמל']);
  setNow(SUNDAY + 6 * MINUTE);
  await said(app, 'יש קצר בסלון', 'q1');
  await settle(app);
  // The answer is in רון's chat, the latest call.
  const ron = db.get('SELECT * FROM chats WHERE customer_id = ?', r.id);
  assert.equal(db.get("SELECT count(*) AS n FROM chat_messages WHERE chat_id = ? AND dir = 'in'", ron.id).n, 1);
  assert.match(claude.seen[0].system[0].text, /"רון חשמל"/);
  // Someone who never called: one line on what this is, not twice in a day.
  await said(app, 'שלום, מי זה?', 's1', '972509990001');
  await said(app, 'הלו?', 's2', '972509990001');
  const toStranger = sent().filter((m) => m.to === '972509990001');
  assert.equal(toStranger.length, 1);
  assert.match(toStranger[0].text.body, /כאן המוקדן של \*על הקו\*/);
  // The business number's messages never reach המוקדן.
  await onWebhook(app, hook({ messages: [{ id: 'biz-1', from: CALLER, type: 'text', text: { body: 'כמה זה עולה?' } }] }));
  assert.equal(db.get("SELECT count(*) AS n FROM chat_messages WHERE msg_id = 'biz-1'").n, 0);
});

test('a customer\'s own number at Telnyx gives the forwarding codes', () => {
  assert.deepEqual(forwardCodes('972771234567'), ['**61*0771234567**20#', '**67*0771234567#', '**62*0771234567#', '*#61#']);
});

test('a lead that became a customer is set up from the lead', () => {
  const { db } = testApp();
  const lead = addLead(db);
  const id = customerFromLead(db, lead);
  const c = db.get('SELECT * FROM customers WHERE id = ?', id);
  assert.equal(c.business, 'אבי אינסטלציה');
  assert.equal(c.phone, '972541234567');
  assert.equal(c.trade, 'plumber');
  assert.equal(customerFromLead(db, lead), id, 'once');
});

test("Telnyx's webhook: signed with Ed25519, answered at once, and read", async () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw32 = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
  const body = JSON.stringify({ data: { event_type: 'call.initiated', id: 'e1', payload: { call_control_id: 'cc-1', from: `+${CALLER}`, to: `+${VOICE}`, direction: 'incoming' } } });
  const ts = String(Math.floor(SUNDAY / 1000));
  const sig = sign(null, Buffer.from(`${ts}|${body}`), privateKey).toString('base64');
  assert.ok(signatureOk(raw32, body, sig, ts, SUNDAY));
  assert.ok(!signatureOk(raw32, `${body} `, sig, ts, SUNDAY), 'another body');
  assert.ok(!signatureOk(raw32, body, sig, ts, SUNDAY + 10 * MINUTE), 'too old');
  assert.deepEqual(readEvent(JSON.parse(body)), { kind: 'call', type: 'call.initiated', id: 'e1', callId: 'cc-1', from: CALLER, to: VOICE, direction: 'incoming', recording: null });

  const { app, sent } = setup({ env: { ...TENV, TELNYX_PUBLIC_KEY: raw32 } });
  const server = createServer(handler(app));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/telnyx/webhook`;
  try {
    assert.equal((await fetch(url, { method: 'POST', body })).status, 401);
    const ok = await fetch(url, { method: 'POST', body, headers: { 'telnyx-signature-ed25519': sig, 'telnyx-timestamp': ts } });
    assert.equal(ok.status, 200);
    await settle(app);
    assert.equal(sent()[0].template.name, 'alhakav_caller_v2');
  } finally {
    server.close();
  }
});

test("the guard: a price, an arrival time or a link Claude writes never reaches the caller, and the log says so", async () => {
  const claude = fakeClaude([{ reply: 'זה עולה בערך 350 ₪, ונגיע אליך תוך שעה. מה הכתובת?', done: false, what: 'סתימה', place: '', urgency: '' }]);
  const { app, sent, logs } = setup({ claude });
  await onCall(app, call(CALLER));
  await said(app, 'סתימה בכיור, כמה זה עולה ומתי תגיעו?', 'in-1');
  await settle(app);
  const reply = sent().at(-1).text.body;
  assert.doesNotMatch(reply, /350|תוך שעה/);
  assert.match(reply, /^מה הכתובת\? את המחיר ואת השעה אבי אינסטלציה יסגרו איתך כשיחזרו אליך\.$/);
  assert.ok(logs.some((l) => /the guard cut price, time/.test(l)));
});

test('past 12 of their messages, המוקדן sends the summary once and stops answering', async () => {
  const turn = { reply: 'ומה עוד?', done: false, what: 'נזילה', place: 'הרצל 1', urgency: '' };
  const claude = fakeClaude(Array.from({ length: 20 }, () => ({ ...turn })));
  const { app, db, sent } = setup({ claude });
  await onCall(app, call(CALLER));
  for (let i = 1; i <= 15; i++) {
    setNow(SUNDAY + i * MINUTE);
    await said(app, `הודעה ${i}`, `in-${i}`);
    await settle(app);
  }
  assert.equal(claude.seen.length, 12, 'Claude answers twelve of their messages, no more');
  const summaries = sent().filter((m) => m.type === 'template' && m.template.name === 'alhakav_summary_v2');
  assert.equal(summaries.length, 1);
  assert.equal(chats(db)[0].state, 'done');
});
