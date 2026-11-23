import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { afterEach, beforeEach, test } from 'node:test';
import { handler } from '../server/app.js';
import { hashPassword } from '../server/auth.js';
import { addMonths, billingOf } from '../server/billing.js';
import { DAY, nowIso, setNow } from '../server/clock.js';
import { PAY } from '../server/copy.js';
import { createCustomer, endAtMonthEnd, getCustomer } from '../server/customers.js';
import { morningClient, morningConfig } from '../server/morning.js';
import { onWebhook } from '../server/outreach.js';
import { PayError, decideReceipt, manualPayment, payTick, sendPayment } from '../server/pay.js';
import { missedCall } from '../server/service.js';
import { ENV, hook, testApp } from './helpers.js';

const SUNDAY = Date.parse('2026-11-22T08:41:00Z'); // 10:41 in Israel
const OWNER = '972541112222';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const PENV = { ...ENV, PAYMENT_DETAILS: 'בנק הפועלים (12), סניף 345, חשבון 678901, על שם ישראל ישראלי', MORNING_CLIENT_ID: 'id', MORNING_CLIENT_SECRET: 'secret', MORNING_ENV: 'sandbox' };

/** Morning, faked: a token, the business's VAT settings, and each document answers number 1000 + n. */
function fakeMorning({ vatRate = 0.18 } = {}) {
  const m = { calls: [], n: 0 };
  m.f = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    m.calls.push({ url: String(url), method: init.method, body, auth: init.headers?.authorization });
    if (String(url).endsWith('/oauth/token')) return Response.json({ accessToken: 'tok', tokenType: 'Bearer', expiresAt: Math.floor(SUNDAY / 1000) + 3600 });
    if (String(url).includes('/documents/info')) return Response.json({ vatRate, exemption: false });
    if (String(url).endsWith('/documents')) return Response.json({ id: `doc-${++m.n}`, number: 1000 + m.n, url: { he: `https://www.greeninvoice.co.il/doc-${m.n}`, origin: `https://www.greeninvoice.co.il/doc-${m.n}` } });
    return Response.json({}, { status: 404 });
  };
  m.documents = () => m.calls.filter((c) => c.url.endsWith('/documents')).map((c) => c.body);
  return m;
}

function setup({ env = PENV, paidUntil = null, status = 'active' } = {}) {
  const ctx = testApp({ env });
  const morning = fakeMorning();
  ctx.app.morning = morningClient(morningConfig(env), morning.f);
  const r = createCustomer(ctx.db, { name: 'אבי כהן', business: 'אבי אינסטלציה', trade: 'plumber', phone: '054-111-2222', assistant: '077-123-4567' });
  ctx.db.run("UPDATE customers SET status = ?, wa_status = 'connected', paid_until = ?, email = 'avi@example.com', tax_id = '012345678' WHERE id = ?", status, paidUntil, r.id);
  return { ...ctx, morning, cid: r.id, c: () => getCustomer(ctx.db, r.id) };
}

const image = (id, media = 'media-1') => ({ from: OWNER, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'image', image: { id: media, mime_type: 'image/jpeg' } });
const texts = (graph) => graph.sent().filter((c) => c.body?.type === 'text').map((c) => c.body.text.body);
const templates = (graph) => graph.sent().filter((c) => c.body?.type === 'template').map((c) => c.body.template);

beforeEach(() => setNow(SUNDAY));
afterEach(() => setNow(null));

test('where a customer stands: new, paid, the week before, the 72 hours, stopped, free, ending', () => {
  const c = { status: 'active', price: 149, free: 0, paid_until: null, ends_on: null };
  const fresh = billingOf(c, '2026-11-22');
  assert.equal(fresh.state, 'new');
  assert.equal(fresh.on, false);
  assert.deepEqual(fresh.owed, { from: '2026-11-22', until: '2026-12-21', net: 149, vat: 26.82, total: 175.82 });

  const paid = { ...c, paid_until: '2026-12-21' };
  assert.deepEqual([billingOf(paid, '2026-12-01').state, billingOf(paid, '2026-12-01').owed], ['paid', null]);
  assert.deepEqual(billingOf(paid, '2026-12-15').owed.from, '2026-12-22'); // six days left: the next month may be paid
  const grace = billingOf(paid, '2026-12-24');
  assert.deepEqual([grace.state, grace.on, grace.owed.from, grace.owed.until], ['grace', true, '2026-12-22', '2027-01-21']);
  const lapsed = billingOf(paid, '2026-12-25');
  assert.deepEqual([lapsed.state, lapsed.on, lapsed.owed.from], ['lapsed', false, '2026-12-25']);

  assert.deepEqual([billingOf({ ...c, free: 1 }, '2026-12-25').on, billingOf({ ...c, free: 1 }, '2026-12-25').owed], [true, null]);
  const ending = { ...paid, ends_on: '2026-12-21' };
  assert.deepEqual([billingOf(ending, '2026-12-21').on, billingOf(ending, '2026-12-22').state], [true, 'ended']);
  assert.equal(addMonths('2026-01-31'), '2026-02-28');
});

test('a picture of the transfer becomes a receipt; "התשלום הגיע" records the month and Morning issues the invoice', async () => {
  const { app, db, graph, morning, cid, c } = setup();
  graph.media['media-1'] = { mime: 'image/jpeg', bytes: JPEG };
  await onWebhook(app, hook({ messages: [image('wamid.in-1')] }));
  const r = db.get('SELECT * FROM receipts');
  assert.equal(r.customer_id, cid);
  assert.equal(r.type, 'image/jpeg');
  assert.equal(JSON.parse(r.owed_json).total, 175.82);
  assert.ok(Buffer.from(r.file).equals(JPEG));
  assert.deepEqual(texts(graph), [PAY.received]);
  // The file was fetched with the token, from Meta's address for it.
  assert.equal(graph.calls.find((x) => x.url === 'https://graph.test/files/media-1').auth, 'Bearer token');
  // The customer's chat on the business number is a customer's, not a new lead.
  const lead = db.get('SELECT * FROM leads WHERE mobile = ?', OWNER);
  assert.deepEqual([lead.stage, lead.closed_why, c().lead_id], ['closed', 'customer', lead.id]);

  // The same picture again is the same receipt.
  await onWebhook(app, hook({ messages: [image('wamid.in-2')] }));
  assert.equal(db.get('SELECT count(*) AS n FROM receipts').n, 1);
  assert.equal(texts(graph).at(-1), PAY.again);

  const out = await decideReceipt(app, r.id, 'paid', '');
  assert.equal(out.bill.until, '2026-12-21');
  assert.equal(c().paid_until, '2026-12-21');
  const [doc] = morning.documents();
  assert.equal(doc.type, 320);
  assert.deepEqual(doc.client, { name: 'אבי אינסטלציה', taxId: '012345678', emails: ['avi@example.com'], add: true });
  assert.deepEqual(doc.income.map((i) => [i.price, i.vatType]), [[149, 0]]);
  assert.deepEqual(doc.payment, [{ date: '2026-11-22', type: 4, price: 175.82, currency: 'ILS' }]);
  const after = db.get('SELECT * FROM receipts WHERE id = ?', r.id);
  assert.deepEqual([after.decision, after.morning_state, after.morning_number], ['paid', 'issued', '1001']);
  assert.match(texts(graph).at(-1), /משולם עד 21\.12\.2026/);
  assert.match(texts(graph).at(-1), /greeninvoice\.co\.il\/doc-1/);
  // This one has its number already. The first payment, with none yet, says the service starts within 24 hours (the
  // owner, 2026-11-23).
  assert.doesNotMatch(texts(graph).at(-1), /24 שעות/);
  assert.match(PAY.paid({ business: 'אבי אינסטלציה', until: '21.12.2026', url: '', setup: true }), /^✅ \*התשלום הגיע, תודה\*\n\nהעוזר של אבי אינסטלציה משולם עד 21\.12\.2026\.\n\n⏰ תוך 24 שעות נשלח לכם כאן את המספר/);

  // Pressed again: nothing recorded, no second invoice.
  await assert.rejects(decideReceipt(app, r.id, 'paid', ''), (e) => e instanceof PayError && e.code === 'already_paid');
  assert.equal(c().paid_until, '2026-12-21');
  assert.equal(morning.documents().length, 1);
});

test('a picture while nothing is owed is just a message, and "לא הגיע" records nothing', async () => {
  const { app, db, graph, c } = setup({ paidUntil: '2027-01-30' });
  graph.media['media-1'] = { mime: 'image/jpeg', bytes: JPEG };
  await onWebhook(app, hook({ messages: [image('wamid.in-1')] }));
  assert.equal(db.get('SELECT count(*) AS n FROM receipts').n, 0);
  assert.equal(db.get("SELECT body FROM messages WHERE dir = 'in'").body, '[תמונה]');
  // A customer writing is in a conversation again, and still a customer.
  assert.deepEqual({ ...db.get('SELECT stage, closed_why FROM leads WHERE mobile = ?', OWNER) }, { stage: 'talking', closed_why: 'customer' });

  db.run("UPDATE customers SET paid_until = '2026-11-24' WHERE id = ?", c().id);
  await onWebhook(app, hook({ messages: [image('wamid.in-2')] }));
  const r = db.get('SELECT * FROM receipts');
  await decideReceipt(app, r.id, 'not_paid', '2026-11-24');
  assert.equal(c().paid_until, '2026-11-24');
  assert.equal(db.get('SELECT decision FROM receipts').decision, 'not_paid');
});

test('"התקבל תשלום" by hand: guarded by the day the page showed, and the next month follows the paid one', async () => {
  const { app, db, morning, c } = setup({ paidUntil: '2026-11-24' });
  await assert.rejects(manualPayment(app, c(), ''), (e) => e.code === 'already_paid');
  const r = await manualPayment(app, c(), '2026-11-24');
  assert.deepEqual([r.bill.from, r.bill.until], ['2026-11-25', '2026-12-24']);
  assert.equal(c().paid_until, '2026-12-24');
  assert.equal(db.get('SELECT source, decision FROM receipts WHERE id = ?', r.id).source, 'manual');
  assert.equal(morning.documents().length, 1);
  // A page left open sends the old day: nothing more is recorded.
  await assert.rejects(manualPayment(app, c(), '2026-11-24'), (e) => e.code === 'already_paid');
});

test('Morning with another VAT rate: the payment stands, and no invoice is issued', async () => {
  const { app, db, c } = setup();
  const morning = fakeMorning({ vatRate: 17 });
  app.morning = morningClient(morningConfig(PENV), morning.f);
  const r = await manualPayment(app, c(), '');
  assert.equal(c().paid_until, '2026-12-21');
  assert.equal(r.invoice.state, 'blocked');
  assert.equal(morning.documents().length, 0);
  assert.equal(JSON.parse(db.get('SELECT morning_error_json FROM receipts').morning_error_json).rate, '17%');
});

test('the reminders: before the end, after it, the last day, after it stopped, each once, never on Shabbat', async () => {
  const { app, db, graph, c } = setup({ paidUntil: '2026-11-24' });
  await payTick(app);
  await payTick(app);
  let sent = templates(graph);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].name, 'alhakav_payment_v2');
  assert.deepEqual(
    sent[0].components[0].parameters.map((p) => p.text),
    ['העוזר של אבי אינסטלציה משולם עד 24.11.2026. זה התשלום על החודש הבא, מ־25.11.2026 עד 24.12.2026.', '175.82', PENV.PAYMENT_DETAILS]
  );
  const at = (iso) => {
    setNow(Date.parse(iso));
    return payTick(app, Date.parse(iso));
  };
  await at('2026-11-25T08:00:00Z'); // Wednesday, the day after
  await at('2026-11-27T08:00:00Z'); // Friday morning, the last day
  await at('2026-11-28T08:00:00Z'); // Shabbat: nothing
  sent = templates(graph).map((t) => t.components[0].parameters[0].text);
  assert.equal(sent.length, 3);
  assert.match(sent[1], /עד סוף 27\.11\.2026/);
  assert.match(sent[2], /עובד עד סוף היום/);
  await at('2026-11-29T08:00:00Z'); // Sunday: it stopped
  assert.match(templates(graph).at(-1).components[0].parameters[0].text, /עצור מ־28\.11\.2026/);
  assert.equal(db.get('SELECT count(*) AS n FROM pay_notices WHERE customer_id = ?', c().id).n, 4);
  // And a forwarded call gets no message now, while the customer's own test call still answers.
  assert.equal((await missedCall(app, c(), '972527654321')).outcome, 'unpaid');
  assert.equal((await missedCall(app, c(), OWNER)).outcome, 'test');
});

test('no reminder while a receipt waits, none to a number that asked us to stop, and the admin\'s button says why', async () => {
  const { app, db, graph, c } = setup({ paidUntil: '2026-11-24' });
  db.run("INSERT INTO receipts (customer_id, business, source, phone, created_at) VALUES (?, 'אבי אינסטלציה', 'whatsapp', ?, ?)", c().id, OWNER, nowIso());
  await payTick(app);
  assert.equal(templates(graph).length, 0);
  db.run("INSERT INTO stops (phone, why, at) VALUES (?, 'די', ?)", OWNER, nowIso());
  assert.deepEqual(await sendPayment(app, c(), 'ask'), { ok: false, why: 'stopped' });
});

test('a stop at the month\'s end, and the transfer pictures deleted after 90 days', async () => {
  const { app, db, c } = setup({ paidUntil: '2026-11-24' });
  endAtMonthEnd(db, c());
  assert.equal(c().ends_on, '2026-11-24');
  db.run("INSERT INTO receipts (customer_id, business, source, phone, type, size, file, created_at) VALUES (?, 'x', 'whatsapp', ?, 'image/jpeg', 12, ?, ?)", c().id, OWNER, JPEG, nowIso(SUNDAY - 91 * DAY));
  setNow(Date.parse('2026-11-25T08:00:00Z'));
  await payTick(app, Date.parse('2026-11-25T08:00:00Z'));
  assert.equal(c().status, 'stopped');
  assert.equal(db.get('SELECT file FROM receipts').file, null);
});

test('the receipt page: the picture, its file, and the two buttons', async () => {
  const PASSWORD = 'correct horse battery';
  const { app, db, graph } = setup({ env: { ...PENV, ADMIN_PASSWORD_HASH: hashPassword(PASSWORD) } });
  graph.media['media-1'] = { mime: 'image/jpeg', bytes: JPEG };
  await onWebhook(app, hook({ messages: [image('wamid.in-1')] }));
  const server = createServer(handler(app));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const jar = new Map();
    const go = async (path, form) => {
      const res = await fetch(`${base}${path}`, { method: form ? 'POST' : 'GET', redirect: 'manual', headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), origin: base, ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) }, body: form ? new URLSearchParams(form).toString() : undefined });
      for (const ck of res.headers.getSetCookie()) {
        const [kv] = ck.split(';');
        const i = kv.indexOf('=');
        jar.set(kv.slice(0, i), kv.slice(i + 1));
      }
      return { status: res.status, location: res.headers.get('location'), type: res.headers.get('content-type'), body: Buffer.from(await res.arrayBuffer()) };
    };
    const csrf = (b) => /name="csrf" value="([^"]+)"/.exec(b.toString())?.[1];
    const login = await go('/admin/login');
    await go('/admin/login', { csrf: csrf(login.body), password: PASSWORD });
    const id = db.get('SELECT id FROM receipts').id;
    const list = (await go('/admin/customers')).body.toString();
    assert.match(list, /אישורי העברה שמחכים/);
    const page = await go(`/admin/receipts/${id}`);
    assert.match(page.body.toString(), new RegExp(`<img src="/admin/receipts/${id}/file"`));
    const file = await go(`/admin/receipts/${id}/file`);
    assert.equal(file.type, 'image/jpeg');
    assert.ok(file.body.equals(JPEG));
    const paid = await go(`/admin/receipts/${id}/paid`, { csrf: csrf(page.body), expect: '' });
    assert.equal(paid.location, `/admin/receipts/${id}`);
    assert.equal(db.get('SELECT paid_until FROM customers').paid_until, '2026-12-21');
    const customer = (await go(`/admin/customers/${db.get('SELECT id FROM customers').id}`)).body.toString();
    assert.match(customer, /משולם עד 21\.12\.2026/);
  } finally {
    server.close();
  }
});
