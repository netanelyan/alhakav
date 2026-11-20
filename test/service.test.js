import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { afterEach, beforeEach, test } from 'node:test';
import { handler } from '../server/app.js';
import { MINUTE, setNow } from '../server/clock.js';
import { createCustomer, customerFromLead, forwardCodes, registerWa, verifyWa } from '../server/customers.js';
import { onCall, onWhatsApp, serviceTick, settle } from '../server/service.js';
import { readEvent, signatureOk } from '../server/telnyx.js';
import { ENV, addLead, testApp } from './helpers.js';

const SUNDAY = Date.parse('2026-11-22T08:41:00Z'); // 10:41 in Israel
const OWNER = '972541112222';
const ASSISTANT = '972771234567';
const CALLER = '972527654321';

/** Telnyx, faked: every message sent answers msg-N; `failNext` makes the next one fail. */
function fakeTelnyx() {
  const t = { calls: [], n: 0, failNext: null };
  t.f = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    t.calls.push({ url: String(url), method: init.method, body });
    if (t.failNext) {
      const detail = t.failNext;
      t.failNext = null;
      return Response.json({ errors: [{ code: '40008', title: 'failed', detail }] }, { status: 400 });
    }
    if (String(url).includes('/messages/whatsapp')) return Response.json({ data: { id: `msg-${++t.n}` } });
    return Response.json({ data: {} });
  };
  t.messages = () => t.calls.filter((c) => c.url.endsWith('/messages/whatsapp')).map((c) => c.body);
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

const TENV = { ...ENV, TELNYX_API_KEY: 'key', TELNYX_PUBLIC_KEY: 'pk', TELNYX_WABA_ID: 'waba1', TELNYX_API: 'https://telnyx.test/v2', REPLY_DELAY_MS: '0' };

function setup({ claude = null, env = TENV } = {}) {
  const tx = fakeTelnyx();
  const ctx = testApp({ env });
  ctx.app.telnyxFetch = tx.f;
  ctx.app.claude = claude;
  const r = createCustomer(ctx.db, { name: 'אבי כהן', business: 'אבי אינסטלציה', trade: 'plumber', phone: '054-111-2222', assistant: '077-123-4567' });
  assert.ok(r.ok, r.flash);
  ctx.db.run("UPDATE customers SET status = 'active', wa_status = 'connected', paid_until = '2026-12-21' WHERE id = ?", r.id);
  return { ...ctx, tx, cid: r.id };
}

const call = (from, id = 'call-1') => ({ kind: 'call', type: 'call.initiated', callId: id, from, to: ASSISTANT, direction: 'incoming' });
const said = (text, id, from = CALLER, extra = {}) => ({ kind: 'whatsapp', type: 'message.received', id, from, to: ASSISTANT, text, ...extra });
const chats = (db) => db.all('SELECT * FROM chats ORDER BY id');

beforeEach(() => setNow(SUNDAY));
afterEach(() => setNow(null));

test('a missed call: the call ends at once, and the caller gets the first message from the assistant number', async () => {
  const { app, db, tx } = setup();
  await onCall(app, call(CALLER));
  assert.deepEqual(tx.actions(), ['reject']);
  const [m] = tx.messages();
  assert.equal(m.from, `+${ASSISTANT}`);
  assert.equal(m.to, `+${CALLER}`);
  assert.equal(m.whatsapp_message.template.name, 'alhakav_caller');
  assert.deepEqual(m.whatsapp_message.template.components[0].parameters, [{ type: 'text', text: 'אבי אינסטלציה' }]);
  assert.equal(db.get('SELECT outcome FROM calls').outcome, 'messaged');
  // The same caller again within 24 hours: the same conversation, no second message.
  await onCall(app, call(CALLER, 'call-2'));
  assert.equal(tx.messages().length, 1);
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
  const { app, db, tx } = setup({ claude });
  await onCall(app, call(CALLER));
  await onWhatsApp(app, said('יש לי נזילה במטבח מתחת לכיור', 'in-1'));
  await settle(app);
  await onWhatsApp(app, said('הרצל 15 אשדוד קומה 3, זורם חזק', 'in-2'));
  await settle(app);
  // Claude saw the whole chat, with the first message, and the business's name in the system prompt.
  assert.match(claude.seen[1].messages[0].content, /העוזר: שלום, כאן העוזר של אבי אינסטלציה/);
  assert.match(claude.seen[1].messages[0].content, /הלקוח: הרצל 15 אשדוד/);
  assert.match(claude.seen[0].system[0].text, /"אבי אינסטלציה"/);
  assert.equal(claude.seen[0].fallbacks, 'default');
  const sent = tx.messages();
  assert.equal(sent[1].whatsapp_message.text.body, 'מה הכתובת?');
  const summary = sent.at(-1);
  assert.equal(summary.to, `+${OWNER}`);
  assert.equal(summary.whatsapp_message.template.name, 'alhakav_summary');
  assert.deepEqual(
    summary.whatsapp_message.template.components[0].parameters.map((p) => p.text),
    ['10:41', 'נזילה חזקה מתחת לכיור', 'הרצל 15, אשדוד, קומה 3', 'דחוף, המים זורמים', '052-765-4321']
  );
  assert.equal(chats(db)[0].state, 'done');
});

test('three messages in a row get one answer', async () => {
  const claude = fakeClaude([{ reply: 'ובאיזו כתובת?', done: false, what: 'סתימה', place: '', urgency: '' }]);
  const { app, tx } = setup({ claude, env: { ...TENV, REPLY_DELAY_MS: '50' } });
  await onCall(app, call(CALLER));
  await onWhatsApp(app, said('היי', 'a'));
  await onWhatsApp(app, said('יש סתימה', 'b'));
  await onWhatsApp(app, said('בשירותים', 'c'));
  await settle(app);
  assert.equal(claude.seen.length, 1);
  assert.equal(tx.messages().filter((m) => m.whatsapp_message.type === 'text').length, 1);
});

test('without Claude, the caller is thanked and what they wrote goes to the customer as it is', async () => {
  const { app, tx } = setup();
  await onCall(app, call(CALLER));
  await onWhatsApp(app, said('ננעלתי בחוץ, הרא״ה 101 רמת גן', 'x'));
  await settle(app);
  const [, thanks, summary] = tx.messages();
  assert.match(thanks.whatsapp_message.text.body, /תודה, הפרטים אצל אבי אינסטלציה/);
  assert.equal(summary.whatsapp_message.template.components[0].parameters[1].text, 'ננעלתי בחוץ, הרא״ה 101 רמת גן');
});

test('"הסר" puts the caller on the list, says so once, and tells the customer', async () => {
  const { app, db, tx } = setup();
  await onCall(app, call(CALLER));
  await onWhatsApp(app, said('הסר', 'stop-1'));
  await settle(app);
  assert.ok(db.get('SELECT 1 FROM skips WHERE phone = ?', CALLER));
  const sent = tx.messages();
  assert.equal(sent[1].whatsapp_message.text.body, 'הסרנו את המספר, ולא נכתוב שוב.');
  assert.equal(sent[2].whatsapp_message.template.name, 'alhakav_call_note');
  // They call again: nothing goes to them.
  setNow(SUNDAY + 2 * 24 * 60 * MINUTE);
  await onCall(app, call(CALLER, 'call-9'));
  assert.equal(tx.messages().length, 3);
  assert.equal(db.get("SELECT outcome FROM calls WHERE call_id = 'call-9'").outcome, 'skipped');
});

test('a hidden number, a test call from the customer, and a first message that never arrives', async () => {
  const { app, db, tx } = setup();
  await onCall(app, call('', 'hidden'));
  let note = tx.messages().at(-1);
  assert.equal(note.whatsapp_message.template.name, 'alhakav_call_note');
  assert.equal(note.whatsapp_message.template.components[0].parameters[0].text, 'ממספר חסוי');
  await onCall(app, call(OWNER, 'test'));
  assert.match(tx.messages().at(-1).whatsapp_message.template.components[0].parameters[2].text, /שיחת בדיקה/);
  await onCall(app, call(CALLER, 'c3'));
  const first = db.get("SELECT msg_id FROM chat_messages WHERE kind = 'first'").msg_id;
  await onWhatsApp(app, { kind: 'whatsapp', type: 'message.finalized', id: first, status: 'delivery_failed', error: 'undeliverable' });
  note = tx.messages().at(-1);
  assert.match(note.whatsapp_message.template.components[0].parameters[2].text, /אין וואטסאפ/);
  assert.equal(chats(db)[0].state, 'failed');
});

test('no answer after 20 minutes: the customer gets a note; a stalled chat gets the summary it has', async () => {
  const claude = fakeClaude([{ reply: 'מה הכתובת?', done: false, what: 'מזגן מטפטף', place: '', urgency: '' }]);
  const { app, db, tx } = setup({ claude });
  await onCall(app, call(CALLER));
  await onCall(app, call('972501231234', 'c2'));
  await onWhatsApp(app, said('המזגן מטפטף', 'm1', '972501231234'));
  await settle(app);
  setNow(SUNDAY + 21 * MINUTE);
  await serviceTick(app);
  const toOwner = tx.messages().filter((m) => m.to === `+${OWNER}`);
  assert.equal(toOwner.length, 2);
  assert.match(toOwner[0].whatsapp_message.template.components[0].parameters[2].text, /עוד אין תשובה/);
  assert.equal(toOwner[1].whatsapp_message.template.name, 'alhakav_summary');
  assert.equal(toOwner[1].whatsapp_message.template.components[0].parameters[1].text, 'מזגן מטפטף');
  await serviceTick(app);
  assert.equal(tx.messages().filter((m) => m.to === `+${OWNER}`).length, 2, 'each goes once');
  // 90 days on, the callers' chats are gone.
  setNow(SUNDAY + 91 * 24 * 60 * MINUTE);
  await serviceTick(app);
  assert.equal(chats(db).length, 0);
});

test('the customer writes to their own assistant: the "לא לשלוח" list, a pause, and texts inside the 24 hours', async () => {
  const { app, db, tx } = setup();
  await onWhatsApp(app, said('לא לשלוח ל 050-999-8877', 'o1', OWNER));
  assert.ok(db.get("SELECT 1 FROM skips WHERE phone = '972509998877' AND why = 'owner'"));
  assert.match(tx.messages().at(-1).whatsapp_message.text.body, /050-999-8877 לא יקבל/);
  await onCall(app, call('972509998877', 'mom'));
  assert.equal(db.get("SELECT outcome FROM calls WHERE call_id = 'mom'").outcome, 'skipped');
  // The owner wrote in the last 24 hours, so a note goes as text, not a template.
  await onCall(app, call('', 'h'));
  assert.equal(tx.messages().at(-1).whatsapp_message.type, 'text');
  await onWhatsApp(app, said('לעצור', 'o2', OWNER));
  assert.equal(db.get('SELECT status FROM customers').status, 'paused');
  await onCall(app, call(CALLER, 'while-paused'));
  assert.equal(db.get("SELECT outcome FROM calls WHERE call_id = 'while-paused'").outcome, 'inactive');
  await onWhatsApp(app, said('להמשיך', 'o3', OWNER));
  assert.equal(db.get('SELECT status FROM customers').status, 'active');
});

test('registering the assistant on WhatsApp: Meta\'s call is recorded, and the code verifies it', async () => {
  const { app, db, tx, cid } = setup();
  db.run("UPDATE customers SET wa_status = 'none', status = 'setup' WHERE id = ?", cid);
  const c = () => db.get('SELECT * FROM customers WHERE id = ?', cid);
  assert.ok((await registerWa(app, c())).ok);
  assert.equal(tx.calls.at(-1).url, 'https://telnyx.test/v2/whatsapp/business_accounts/waba1/phone_numbers');
  assert.equal(tx.calls.at(-1).body.verification_method, 'voice');
  await onCall(app, call('15550001111', 'meta-otp'));
  assert.deepEqual(tx.actions(), ['answer', 'record_start']);
  await onCall(app, { kind: 'call', type: 'call.recording.saved', callId: 'meta-otp', to: ASSISTANT, recording: 'https://rec.test/otp.mp3' });
  assert.equal(c().otp_recording, 'https://rec.test/otp.mp3');
  assert.ok((await verifyWa(app, c(), '123-456')).ok);
  assert.equal(tx.calls.find((x) => x.url.endsWith('/verify')).body.code, '123456');
  assert.equal(c().wa_status, 'connected');
  assert.deepEqual(forwardCodes(c().assistant), ['**61*0771234567**20#', '**67*0771234567#', '**62*0771234567#', '*#61#']);
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
  const body = JSON.stringify({ data: { event_type: 'call.initiated', id: 'e1', payload: { call_control_id: 'cc-1', from: `+${CALLER}`, to: `+${ASSISTANT}`, direction: 'incoming' } } });
  const ts = String(Math.floor(SUNDAY / 1000));
  const sig = sign(null, Buffer.from(`${ts}|${body}`), privateKey).toString('base64');
  assert.ok(signatureOk(raw32, body, sig, ts, SUNDAY));
  assert.ok(!signatureOk(raw32, `${body} `, sig, ts, SUNDAY), 'another body');
  assert.ok(!signatureOk(raw32, body, sig, ts, SUNDAY + 10 * MINUTE), 'too old');
  assert.deepEqual(readEvent(JSON.parse(body)), { kind: 'call', type: 'call.initiated', id: 'e1', callId: 'cc-1', from: CALLER, to: ASSISTANT, direction: 'incoming', recording: null });
  const wa = readEvent({ data: { event_type: 'message.received', payload: { id: 'm-1', type: 'WHATSAPP', from: { phone_number: `+${CALLER}` }, to: [{ phone_number: `+${ASSISTANT}` }], body: { text: { body: 'היי' } } } } });
  assert.equal(wa.text, 'היי');
  assert.equal(wa.from, CALLER);
  assert.equal(wa.to, ASSISTANT);

  const { app, tx } = setup({ env: { ...TENV, TELNYX_PUBLIC_KEY: raw32 } });
  const server = createServer(handler(app));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/telnyx/webhook`;
  try {
    assert.equal((await fetch(url, { method: 'POST', body })).status, 401);
    const ok = await fetch(url, { method: 'POST', body, headers: { 'telnyx-signature-ed25519': sig, 'telnyx-timestamp': ts } });
    assert.equal(ok.status, 200);
    await settle(app);
    assert.equal(tx.messages()[0].whatsapp_message.template.name, 'alhakav_caller');
  } finally {
    server.close();
  }
});
