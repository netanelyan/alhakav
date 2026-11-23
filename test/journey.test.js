import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { handler } from '../server/app.js';
import { hashPassword } from '../server/auth.js';
import { now, setNow } from '../server/clock.js';
import { PAY } from '../server/copy.js';
import { createCustomer } from '../server/customers.js';
import { morningClient, morningConfig } from '../server/morning.js';
import { forgetNumberLook, groupTick, numbersTick } from '../server/numbers.js';
import { forgetQuality } from '../server/outreach.js';
import { payTick } from '../server/pay.js';
import { local } from '../server/phones.js';
import { serviceTick, settle } from '../server/service.js';
import { codeLine, setupCodes } from '../server/setup.js';
import { TORAN_ENV, addLead, fakeGraph, fakeToran, hook, testApp } from './helpers.js';

// One new tradesperson, the whole way: found, written to, says yes, opens their page and tries המוקדן, joins through
// Toran, pays, gets their number and the codes, and from then on a missed call is answered and summed up. Every step
// has its own tests; this one runs them in a row, through the real HTTP handler and webhooks, to see where the steps
// meet. JOURNEY_PRINT=1 prints every message in order, as the tradesperson and the caller get them.

const PASSWORD = 'correct horse battery';
const BIZ = '123'; // the business number's Meta id (META_PHONE_ID)
const ASSIST = '456'; // המוקדן's
const LEAD = '972541234567'; // the plumber's mobile, read from the fixture's site
const CALLER = '972527654321';
const MOM = '972509998877';
const NEW_NUMBER = '97243763891'; // the number Telnyx sells us for them
const OWNERS_TEST = '97243763889'; // the owner's own test number, held by their test customer
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const LRM = '‎';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const TELNYX_KEY = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
const JENV = {
  ...TORAN_ENV,
  ADMIN_PASSWORD_HASH: hashPassword(PASSWORD),
  ASSIST_PHONE_ID: ASSIST,
  REPLY_DELAY_MS: '0',
  TELNYX_API_KEY: 'key',
  TELNYX_PUBLIC_KEY: TELNYX_KEY,
  TELNYX_API: 'https://telnyx.test/v2',
  TELNYX_CONNECTION_ID: 'conn1',
  TELNYX_REQUIREMENT_GROUP: 'grp1',
  MORNING_CLIENT_ID: 'id',
  MORNING_CLIENT_SECRET: 'secret',
  MORNING_ENV: 'sandbox',
};

/** Sunday 22.11.2026 at an Israel hour, "10:00". */
const clock = (hhmm) => setNow(Date.parse(`2026-11-22T${hhmm}:00+02:00`));

/** Telnyx, faked: our numbers on the voice app, one for sale, the documents approved, and every call action ok. */
function fakeTelnyx() {
  const t = { owned: [[`+${OWNERS_TEST}`, 'active']], available: [[`+${NEW_NUMBER}`, 3, 3]], orders: [], actions: [] };
  t.f = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://telnyx.test/v2/phone_numbers?')) return Response.json({ data: t.owned.map(([n, status], i) => ({ id: String(i + 1), phone_number: n, status })) });
    if (u.startsWith('https://telnyx.test/v2/available_phone_numbers?')) return Response.json({ data: t.available.map(([n, up, mo]) => ({ phone_number: n, cost_information: { upfront_cost: String(up), monthly_cost: String(mo), currency: 'USD' } })) });
    if (u === 'https://telnyx.test/v2/number_orders' && init.method === 'POST') {
      const body = JSON.parse(init.body);
      t.orders.push(body);
      t.owned.push([body.phone_numbers[0].phone_number, 'requirement-info-under-review']);
      return Response.json({ data: { id: `ord${t.orders.length}`, status: 'pending' } });
    }
    if (u === 'https://telnyx.test/v2/requirement_groups/grp1') return Response.json({ data: { status: 'approved', regulatory_requirements: [{ field_type: 'document', status: 'approved' }, { field_type: 'address', status: 'approved' }] } });
    const action = /\/calls\/([^/]+)\/actions\/(\w+)$/.exec(u);
    if (action) {
      t.actions.push(action[2]);
      return Response.json({ data: {} });
    }
    return Response.json({ errors: [{ detail: `unexpected ${u}` }] }, { status: 404 });
  };
  return t;
}

/** Morning, faked: a token, VAT at 18%, and each document answers number 1000 + n. */
function fakeMorning() {
  const m = { documents: [], n: 0 };
  m.f = async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith('/oauth/token')) return Response.json({ accessToken: 'tok', tokenType: 'Bearer', expiresAt: Math.floor(now() / 1000) + 3600 });
    if (u.includes('/documents/info')) return Response.json({ vatRate: 0.18, exemption: false });
    if (u.endsWith('/documents')) {
      m.documents.push(JSON.parse(init.body));
      return Response.json({ id: `doc-${++m.n}`, number: 1000 + m.n, url: { he: `https://www.greeninvoice.co.il/doc-${m.n}` } });
    }
    return Response.json({}, { status: 404 });
  };
  return m;
}

/** Claude, faked: the scripted turns in order, for the try on their page and for the caller. */
function fakeClaude(turns) {
  const seen = [];
  return {
    seen,
    model: 'claude-sonnet-5-5',
    messages: {
      create: async (req) => {
        seen.push(req);
        return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(turns.shift()) }] };
      },
    },
  };
}

// Everything that went out and came in, in order: { step } a heading, { dir: 'out' } a message Meta was asked to send
// (from which of our numbers, to whom, a template or text), { dir: 'in' } a message to one of our numbers, { dir:
// 'call' } a call Telnyx handed us.
const log = [];
const outs = () => log.filter((x) => x.dir === 'out');
const step = (title) => log.push({ step: title });

let ctx;
let server;
let base;
let telnyx;
let morning;
let toran;
let claude;
let n = 0;

before(async () => {
  clock('09:30');
  forgetQuality();
  forgetNumberLook();
  const graph = fakeGraph();
  const send = graph.f;
  graph.f = async (url, init = {}) => {
    const res = await send(url, init);
    const sent = /\/v23\.0\/(\d+)\/messages$/.exec(String(url));
    if (sent && init.method === 'POST') {
      const b = JSON.parse(init.body);
      const id = (await res.clone().json()).messages?.[0]?.id || null;
      log.push({ dir: 'out', line: sent[1], to: b.to, type: b.type, template: b.template?.name, params: b.template?.components?.[0]?.parameters?.map((p) => p.text) || [], button: b.template?.components?.find((c) => c.type === 'button')?.parameters?.[0]?.text, text: b.text?.body, id });
    }
    return res;
  };
  toran = fakeToran([{ reply: 'מעולה, שמחים שאתם מצטרפים. פרטי התשלום מגיעים בהודעה הבאה.', handoff: { reason: 'join', summary: 'רוצה להצטרף', business: 'אבי אינסטלציה' } }]);
  ctx = testApp({ env: JENV, graph, toranFetch: toran.f });
  telnyx = fakeTelnyx();
  morning = fakeMorning();
  claude = fakeClaude([
    // The try on their page: they write as a caller would, and it ends with the summary they would get.
    { reply: 'תודה, הפרטים אצל אבי אינסטלציה והם יחזרו אליך כשיתפנו.', done: true, what: 'האסלה סתומה, המים עולים', place: 'הרצל 5, אשדוד', urgency: 'דחוף' },
    // The real caller, later: one question, then done.
    { reply: 'מה הכתובת?', done: false, what: 'נזילה מתחת לכיור במטבח', place: '', urgency: '' },
    { reply: 'תודה, הפרטים אצל אבי אינסטלציה והם יחזרו אליך כשיתפנו.', done: true, what: 'נזילה מתחת לכיור במטבח', place: 'רוטשילד 12, אשדוד, קומה 2', urgency: 'דחוף, המים זורמים' },
  ]);
  ctx.app.telnyxFetch = telnyx.f;
  ctx.app.morning = morningClient(morningConfig(JENV), morning.f);
  ctx.app.claude = claude;
  // The owner's own test customer holds the test number, as on the server, so a new customer is never given it.
  assert.ok(createCustomer(ctx.db, { name: 'בדיקה', business: 'בדיקה', phone: '050-000-0123', assistant: local(OWNERS_TEST) }).ok);
  server = createServer(handler(ctx.app));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  setNow(null);
  server.close();
});

// ---- the doors the real system comes in by

const jar = new Map();
/** The admin's browser: cookies kept, every POST from this origin. */
async function browse(path, form) {
  const res = await fetch(`${base}${path}`, {
    method: form ? 'POST' : 'GET',
    redirect: 'manual',
    headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), origin: base, ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  for (const c of res.headers.getSetCookie()) {
    const [kv] = c.split(';');
    const i = kv.indexOf('=');
    if (/Max-Age=0/.test(c)) jar.delete(kv.slice(0, i));
    else jar.set(kv.slice(0, i), kv.slice(i + 1));
  }
  return { status: res.status, location: res.headers.get('location'), text: await res.text() };
}

/** The fields of the form on a page that posts to `action`, as the browser would send them on its button. */
function formOn(html, action) {
  const f = new RegExp(`<form method="post" action="${action}"[^>]*>([\\s\\S]*?)</form>`).exec(html);
  assert.ok(f, `no form for ${action}`);
  const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  return Object.fromEntries([...f[1].matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((x) => [x[1], unesc(x[2])]));
}

/** Pressing the button of the form that posts to `action` on the page at `path`. */
async function press(path, action) {
  const page = await browse(path);
  assert.equal(page.status, 200, path);
  const r = await browse(action, formOn(page.text, action));
  assert.equal(r.status, 303, action);
  return r;
}

/** A message to one of our WhatsApp numbers, posted to /meta/webhook as Meta signs it. */
async function whatsapp(line, from, message, name) {
  const m = { id: `wamid.in-${++n}`, from, timestamp: String(Math.floor(now() / 1000)), ...message };
  log.push({ dir: 'in', line, from, text: m.text?.body ?? (m.image ? '[צילום של ההעברה]' : `[${m.type}]`) });
  const body = JSON.stringify(hook({ phoneId: line, name, messages: [m] }));
  const res = await fetch(`${base}/meta/webhook`, { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', JENV.META_APP_SECRET).update(body).digest('hex')}` } });
  assert.equal(res.status, 200);
  // המוקדן answers a moment after the last message, and the answer runs after the webhook is answered.
  await settle(ctx.app);
}
const text = (line, from, body, name = 'אבי') => whatsapp(line, from, { type: 'text', text: { body } }, name);

/** A call forwarded to a customer's number: Telnyx's call.initiated, signed with Ed25519. */
async function call(from, to) {
  log.push({ dir: 'call', from, to });
  const id = ++n;
  const body = JSON.stringify({ data: { event_type: 'call.initiated', id: `ev-${id}`, payload: { call_control_id: `cc-${id}`, from: `+${from}`, to: `+${to}`, direction: 'incoming' } } });
  const ts = String(Math.floor(now() / 1000));
  const sig = sign(null, Buffer.from(`${ts}|${body}`), privateKey).toString('base64');
  const res = await fetch(`${base}/telnyx/webhook`, { method: 'POST', body, headers: { 'telnyx-signature-ed25519': sig, 'telnyx-timestamp': ts } });
  assert.equal(res.status, 200);
  await settle(ctx.app);
}

const lead = () => ctx.db.get('SELECT * FROM leads WHERE mobile = ?', LEAD);
const customer = () => ctx.db.get('SELECT * FROM customers WHERE phone = ?', LEAD);
const alerts = () => toran.alerts.map((a) => a.title);
/** What went out since the mark, and the mark for the next step. */
let mark = 0;
const since = () => {
  const all = outs();
  const fresh = all.slice(mark);
  mark = all.length;
  return fresh;
};

// ---- the journey

test('Telnyx approved our documents, and a lead found by a search gets the first message from the business number, with their page', async () => {
  step('0. Telnyx approves our documents');
  assert.equal(await groupTick(ctx.app), 'approved');
  assert.match(alerts().at(-1), /Telnyx אישרו את המסמכים/);

  step('1. a lead found by a search, and the first message');
  clock('10:00');
  addLead(ctx.db);
  const login = await browse('/admin/login');
  assert.equal((await browse('/admin/login', { csrf: formOn(login.text, '/admin/login').csrf, password: PASSWORD })).location, '/admin/leads');
  assert.match((await browse('/admin/leads')).text, /אבי אינסטלציה/);
  const r = await press(`/admin/leads/${lead().id}`, `/admin/leads/${lead().id}/send`);
  assert.equal(r.location, `/admin/leads/${lead().id}#send`);
  const [first] = since();
  assert.deepEqual([first.line, first.to, first.template, first.params], [BIZ, LEAD, 'alhakav_page', ['אצל אבי אינסטלציה']]);
  assert.match(lead().page_code, /^[a-z0-9]{10}$/);
  assert.equal(first.button, lead().page_code, 'the button opens their own page');
  assert.equal(lead().stage, 'waiting');
});

test('"כן, שלחו" gets the explanation with their page, the page opens, and its button lets them try המוקדן on themselves', async () => {
  step('2. they answer "כן, שלחו", open the page and try המוקדן');
  clock('10:20');
  await text(BIZ, LEAD, 'כן, שלחו');
  const url = `https://alhakav.example/p/${lead().page_code}`;
  const [pitch] = since();
  assert.deepEqual([pitch.line, pitch.to, pitch.type], [BIZ, LEAD, 'text']);
  assert.ok(pitch.text.includes(url));
  assert.match(pitch.text, /\*149 ₪ לחודש\*, לא כולל מע״מ/);
  assert.match(alerts().at(-1), /אבי אינסטלציה, 054-123-4567 ענו "כן"/);

  clock('10:25');
  const page = await fetch(url.replace('https://alhakav.example', base));
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /בשביל אבי אינסטלציה/);
  assert.equal(lead().page_views, 1);
  // "לנסות בוואטסאפ" opens a message to המוקדן with the page's code in it; they send it as it is.
  const tryLink = new URL(/href="(https:\/\/wa\.me\/[^"]+)"/.exec(html)[1].replace(/&amp;/g, '&'));
  assert.equal(tryLink.pathname, `/${JENV.ASSIST_NUMBER}`);
  await text(ASSIST, LEAD, tryLink.searchParams.get('text'));
  await text(ASSIST, LEAD, 'האסלה סתומה והמים עולים, הרצל 5 אשדוד, דחוף');
  const tried = since();
  assert.ok(tried.every((m) => m.line === ASSIST && m.to === LEAD && m.type === 'text'), 'the try is all המוקדן');
  assert.match(tried[0].text, /עכשיו אתם הלקוח: נגיד שהתקשרתם לאבי אינסטלציה/);
  assert.match(tried.at(-2).text, /📍 \*איפה:\* הרצל 5, אשדוד/);
  // Its last line sends them to the business number, where joining is.
  assert.match(tried.at(-1).text, /רוצים את זה על המספר שלכם\?\* כתבו לנו כאן: https:\/\/wa\.me\/972515310498/);
});

test('they tell Toran they want to join, and get the amount and the transfer details right after its answer', async () => {
  step('3. they want to join, through Toran');
  clock('10:40');
  await text(BIZ, LEAD, 'אני רוצה להצטרף');
  assert.match(toran.calls[0].body.context, /A tradesperson we wrote to first \(אבי אינסטלציה\)[\s\S]*said yes/);
  const c = customer();
  assert.deepEqual([c.business, c.name, c.trade, c.status, c.lead_id], ['אבי אינסטלציה', 'אבי', 'plumber', 'setup', lead().id]);
  assert.equal(lead().closed_why, 'customer');
  const [bot, pay] = since();
  assert.deepEqual([bot.line, bot.to, bot.text], [BIZ, LEAD, 'מעולה, שמחים שאתם מצטרפים. פרטי התשלום מגיעים בהודעה הבאה.']);
  assert.deepEqual([pay.line, pay.to, pay.type], [BIZ, LEAD, 'text']);
  assert.match(pay.text, /החודש הראשון של העוזר של אבי אינסטלציה, מ־22\.11\.2026 עד 21\.12\.2026/);
  assert.match(pay.text, /\*לתשלום:\* 175\.82 ₪ כולל מע״מ/);
  assert.ok(pay.text.includes(JENV.PAYMENT_DETAILS));
  assert.match(alerts().at(-1), /אבי אינסטלציה, 054-123-4567 רוצים להצטרף, ושלחתי להם את פרטי התשלום/);
});

test('the transfer\'s picture is a receipt; "התשלום הגיע" records the month, Morning issues the invoice, and they are told', async () => {
  step('4. the picture of the transfer, and the admin presses "התשלום הגיע"');
  clock('11:30');
  ctx.graph.media['media-1'] = { mime: 'image/jpeg', bytes: JPEG };
  await whatsapp(BIZ, LEAD, { type: 'image', image: { id: 'media-1', mime_type: 'image/jpeg' } }, 'אבי');
  const r = ctx.db.get('SELECT * FROM receipts WHERE customer_id = ?', customer().id);
  assert.ok(r, 'a receipt');
  assert.equal(JSON.parse(r.owed_json).total, 175.82);
  assert.deepEqual(since().map((m) => [m.line, m.to, m.text]), [[BIZ, LEAD, PAY.received]]);
  assert.match(alerts().at(-1), /אבי אינסטלציה, 054-123-4567 שלחו צילום של העברה בנקאית/);

  clock('12:00');
  assert.match((await browse('/admin/customers')).text, new RegExp(`href="/admin/receipts/${r.id}"`));
  const done = await press(`/admin/receipts/${r.id}`, `/admin/receipts/${r.id}/paid`);
  assert.equal(done.location, `/admin/receipts/${r.id}`);
  assert.match((await browse(done.location)).text, /התשלום נרשם\. משולם עד 21\.12\.2026\. Morning הפיק חשבונית מס קבלה 1001\./);
  assert.equal(customer().paid_until, '2026-12-21');
  const [doc] = morning.documents;
  assert.deepEqual([doc.type, doc.client.name, doc.income[0].price, doc.payment[0].price], [320, 'אבי אינסטלציה', 149, 175.82]);
  assert.equal(doc.income[0].description, 'על הקו, 22.11.2026 עד 21.12.2026');
  const [paid] = since();
  assert.deepEqual([paid.line, paid.to, paid.type], [BIZ, LEAD, 'text']);
  assert.match(paid.text, /^✅ \*התשלום הגיע, תודה\*\n\nהעוזר של אבי אינסטלציה משולם עד 21\.12\.2026\./);
  assert.match(paid.text, /⏰ תוך 24 שעות נשלח לכם כאן שלושה קודים להקליד בחייגן/);
  assert.match(paid.text, /🧾 החשבונית: https:\/\/www\.greeninvoice\.co\.il\/doc-1/);
});

test('their number is bought when the payment is approved, and the moment Telnyx makes it work the codes go to them', async () => {
  step('5. their number, and the forwarding codes');
  // Bought with our documents and the voice app; the owner's test number is someone else's.
  assert.deepEqual(telnyx.orders, [{ phone_numbers: [{ phone_number: `+${NEW_NUMBER}`, requirement_group_id: 'grp1' }], connection_id: 'conn1', customer_reference: `alhakav-customer-${customer().id}` }]);
  assert.equal(customer().assistant, NEW_NUMBER);
  assert.match(alerts().at(-1), /קנינו מספר לאבי אינסטלציה, 04-376-3891/);
  clock('12:15');
  await numbersTick(ctx.app, now());
  assert.equal(since().length, 0, 'no codes while Telnyx still reviews the number');
  clock('12:40');
  telnyx.owned[1][1] = 'active';
  await numbersTick(ctx.app, now());
  const [setup] = since();
  assert.deepEqual([setup.line, setup.to, setup.type], [BIZ, LEAD, 'text']);
  assert.match(setup.text, /^✅ \*העוזר של אבי אינסטלציה מוכן\*/);
  const codes = setupCodes(NEW_NUMBER);
  assert.deepEqual(codes, ['**61*043763891**20#', '**67*043763891#', '**62*043763891#']);
  for (const code of codes) assert.ok(setup.text.split('\n').includes(codeLine(code)), code);
  assert.ok(setup.text.includes(`\`\`\`${LRM}**61*043763891**20#${LRM}\`\`\``));
  assert.match(setup.text, /כותבים למוקדן בוואטסאפ, למספר 055-273-5207, "לא לשלוח"/);
  assert.match(alerts().at(-1), /אבי אינסטלציה קיבלו את הקודים להעברת השיחות/);
  // The message says the assistant is ready, so it is: a call forwarded from here on is answered.
  assert.equal(customer().status, 'active');
});

test('a test call from their own phone, then a stranger\'s missed call: המוקדן writes to the caller, and the summary reaches them', async () => {
  step('6. a test call from their own phone, then a stranger calls and is not answered');
  clock('12:50');
  await call(LEAD, NEW_NUMBER);
  assert.deepEqual(telnyx.actions, ['reject']);
  const [test] = since();
  assert.deepEqual([test.line, test.to, test.template], [ASSIST, LEAD, 'alhakav_call_alert_v2']);
  assert.deepEqual(test.params, ['12:50', '054-123-4567', 'זו שיחת בדיקה, והעוזר קיבל אותה. הכול מחובר.']);

  clock('14:00');
  await call(CALLER, NEW_NUMBER);
  const [hello] = since();
  assert.deepEqual([hello.line, hello.to, hello.template, hello.params], [ASSIST, CALLER, 'alhakav_caller_v2', ['אבי אינסטלציה']]);
  clock('14:02');
  await text(ASSIST, CALLER, 'יש נזילה מתחת לכיור במטבח', 'רונית');
  clock('14:03');
  await text(ASSIST, CALLER, 'רוטשילד 12 אשדוד, קומה 2. המים זורמים', 'רונית');
  // Claude was told whose caller this is, and saw the chat from המוקדן's first message.
  assert.match(claude.seen[1].system[0].text, /"אבי אינסטלציה"/);
  assert.match(claude.seen[2].messages[0].content, /העוזר: 👋 שלום, כאן העוזר של אבי אינסטלציה/);
  const [ask, thanks, summary] = since();
  assert.deepEqual([ask.line, ask.to, ask.text], [ASSIST, CALLER, 'מה הכתובת?']);
  assert.deepEqual([thanks.line, thanks.to], [ASSIST, CALLER]);
  assert.match(thanks.text, /הפרטים אצל אבי אינסטלציה/);
  assert.deepEqual([summary.line, summary.to, summary.template], [ASSIST, LEAD, 'alhakav_summary_v2']);
  assert.deepEqual(summary.params, ['14:00', 'נזילה מתחת לכיור במטבח', 'רוטשילד 12, אשדוד, קומה 2', 'דחוף, המים זורמים', '052-765-4321']);
});

test('they write "לא לשלוח" and a number to המוקדן, as the setup message taught, and that number gets nothing', async () => {
  step('7. they keep their mother off המוקדן\'s messages');
  clock('14:30');
  // In the very words of the example in the setup message.
  await text(ASSIST, LEAD, `לא לשלוח ${local(MOM).replace(/-/g, '')}`);
  const [ok] = since();
  assert.deepEqual([ok.line, ok.to, ok.text], [ASSIST, LEAD, '🚫 סגור, 050-999-8877 לא יקבל ממני הודעות.']);
  clock('15:00');
  await call(MOM, NEW_NUMBER);
  assert.equal(since().length, 0, 'their mother gets no message');
  assert.equal(ctx.db.get('SELECT outcome FROM calls ORDER BY id DESC LIMIT 1').outcome, 'skipped');
  // The minute's ticks an hour on: no note, no summary twice, no payment reminder.
  clock('16:00');
  await serviceTick(ctx.app, now());
  await payTick(ctx.app, now());
  assert.equal(since().length, 0);
});

test('the whole way, in order: every message to the tradesperson and the caller, and the number it came from', () => {
  const who = { [LEAD]: 'tradesperson', [CALLER]: 'caller', [MOM]: 'their mother' };
  const line = { [BIZ]: 'business', [ASSIST]: 'המוקדן' };
  // The owner's alerts went through Toran: everything Meta was asked to send went to these two, and all of it went.
  assert.ok(outs().every((m) => who[m.to] === 'tradesperson' || who[m.to] === 'caller'));
  assert.deepEqual(ctx.logs.filter((l) => /not sent|failed|refused|\[http\]/.test(l)), []);
  assert.deepEqual(
    outs().map((m) => `${line[m.line]} -> ${who[m.to]}: ${m.template || m.type}`),
    [
      'business -> tradesperson: alhakav_page',
      'business -> tradesperson: text', // the explanation, after "כן, שלחו"
      'המוקדן -> tradesperson: text', // the try: what it is
      'המוקדן -> tradesperson: text', // the try: the message a caller gets
      'המוקדן -> tradesperson: text', // the try: thanks
      'המוקדן -> tradesperson: text', // the try: the summary they would get
      'המוקדן -> tradesperson: text', // the try: "רוצים את זה על המספר שלכם?"
      'business -> tradesperson: text', // Toran
      'business -> tradesperson: text', // the amount and the transfer details
      'business -> tradesperson: text', // the picture came
      'business -> tradesperson: text', // the payment came, with the invoice
      'business -> tradesperson: text', // the codes
      'המוקדן -> tradesperson: alhakav_call_alert_v2', // the test call
      'המוקדן -> caller: alhakav_caller_v2',
      'המוקדן -> caller: text',
      'המוקדן -> caller: text',
      'המוקדן -> tradesperson: alhakav_summary_v2',
      'המוקדן -> tradesperson: text', // "לא לשלוח"
    ]
  );
  if (process.env.JOURNEY_PRINT !== '1') return;
  // The template's body as the person reads it is kept with the message, by Meta's id.
  const { db } = ctx;
  const bodyOf = (id) => db.get('SELECT body FROM messages WHERE wa_id = ?', id)?.body ?? db.get('SELECT body FROM chat_messages WHERE msg_id = ?', id)?.body ?? '';
  const name = (phone) => `${who[phone] || phone} (${local(phone)})`;
  const indent = (s) => String(s).replace(/^/gm, '        ');
  const lines = [];
  for (const x of log) {
    if (x.step) lines.push('', `== ${x.step}`);
    else if (x.dir === 'out') {
      lines.push(`OUT  ${line[x.line]} -> ${name(x.to)}  ${x.template ? `template ${x.template} [${x.params.join(' | ')}]${x.button ? ` button ${x.button}` : ''}` : 'text'}`);
      lines.push(indent(x.text ?? bodyOf(x.id)));
    } else if (x.dir === 'in') lines.push(`IN   ${name(x.from)} -> ${line[x.line]}`, indent(x.text));
    else lines.push(`CALL ${name(x.from)} -> their number ${local(x.to)}, forwarded to Telnyx`);
  }
  console.log(lines.join('\n'));
});
