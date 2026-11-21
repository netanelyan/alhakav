import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { HOUR, setNow } from '../server/clock.js';
import { forgetQuality, onWebhook, reply, sendPitch } from '../server/outreach.js';
import { ENV, TORAN_ENV, addLead, fakeToran, hook, testApp } from './helpers.js';

const SUNDAY = Date.parse('2026-11-22T08:00:00Z'); // Sunday 10:00 in Israel
const DANI = '972529998877';
const text = (id, body, from = DANI) => ({ id, from, type: 'text', text: { body } });
const out = (db, phone = DANI) => db.all("SELECT * FROM messages WHERE phone = ? AND dir = 'out' ORDER BY id", phone);

beforeEach(() => {
  setNow(SUNDAY);
  forgetQuality();
});
afterEach(() => setNow(null));

test('someone new writes: Toran answers from the business number, and the admin is told once', async () => {
  const toran = fakeToran([{ reply: 'היי, אני תורן, הבוט של על הקו. 149 ₪ לחודש, לא כולל מע״מ.' }, { reply: 'אין דמי הקמה.' }]);
  const { app, db, graph } = testApp({ env: TORAN_ENV, toranFetch: toran.f });
  await onWebhook(app, hook({ name: 'דני', messages: [text('wamid.a', 'כמה זה עולה?')] }));
  const [ask] = toran.calls;
  assert.equal(ask.url, 'http://toran.test/internal/company/answer');
  assert.equal(ask.auth, `Bearer ${'t'.repeat(40)}`);
  assert.equal(ask.body.domain, 'alhakav.example');
  assert.equal(ask.body.phone, DANI);
  assert.equal(ask.body.name, 'דני');
  assert.deepEqual(ask.body.messages.map((m) => [m.id, m.text]), [['wamid.a', 'כמה זה עולה?']]);
  assert.deepEqual(ask.body.operator, []);
  assert.match(ask.body.context, /wrote to us first/);
  const [bot] = out(db);
  assert.equal(bot.kind, 'bot');
  assert.match(bot.body, /149 ₪/);
  assert.equal(graph.sent()[0].body.text.body, bot.body);
  assert.equal(toran.alerts.length, 1);
  assert.equal(toran.alerts[0].product, 'alhakav');
  assert.match(toran.alerts[0].key, /^new:\d+$/);
  assert.match(toran.alerts[0].title, /הודעה חדשה מ־דני, 052-999-8877/);
  assert.match(toran.alerts[0].body, /כמה זה עולה\?[\s\S]*https:\/\/alhakav\.example\/admin\/leads\/\d+/);
  // The next message: answered, no second alert; the same webhook again: nothing.
  await onWebhook(app, hook({ name: 'דני', messages: [text('wamid.b', 'ויש דמי הקמה?')] }));
  await onWebhook(app, hook({ name: 'דני', messages: [text('wamid.b', 'ויש דמי הקמה?')] }));
  assert.equal(toran.calls.length, 2);
  assert.equal(out(db).length, 2);
  assert.equal(toran.alerts.length, 1);
});

test('Toran down: someone new gets the explanation once, and the admin is told to answer', async () => {
  const toran = fakeToran([new Error('connect ECONNREFUSED'), 502]);
  const { app, db } = testApp({ env: TORAN_ENV, toranFetch: toran.f });
  await onWebhook(app, hook({ name: 'דני', messages: [text('wamid.a', 'היי')] }));
  await onWebhook(app, hook({ name: 'דני', messages: [text('wamid.b', 'שלום?')] }));
  const sent = out(db);
  assert.deepEqual(sent.map((m) => m.kind), ['welcome']);
  assert.match(sent[0].body, /149 ₪ לחודש/);
  assert.match(sent[0].body, /https:\/\/alhakav\.example/);
  assert.equal(toran.alerts.length, 2);
  assert.match(toran.alerts[0].title, /תורן לא ענה ל־דני/);
  assert.match(toran.alerts[0].body, /צריך לענות להם מהדף שלהם/);
});

test('without Toran set up: the explanation once, and nothing is asked of Toran', async () => {
  const toran = fakeToran();
  const { app, db } = testApp({ env: ENV, toranFetch: toran.f });
  await onWebhook(app, hook({ name: 'דני', messages: [text('wamid.a', 'היי, ראיתי את האתר')] }));
  await onWebhook(app, hook({ name: 'דני', messages: [text('wamid.b', 'מתי אפשר להתחיל?')] }));
  assert.deepEqual(out(db).map((m) => m.kind), ['welcome']);
  assert.equal(toran.calls.length, 0);
  assert.equal(toran.alerts.length, 0); // no token: a log line only
});

test('the admin answers by hand: it goes to Toran with the next message, and Toran keeps quiet for 12 hours', async () => {
  const toran = fakeToran([{ reply: 'תשובה ראשונה' }, { reply: 'זה שוב תורן' }, { reply: 'אחרי 12 שעות' }]);
  const { app, db } = testApp({ env: TORAN_ENV, toranFetch: toran.f });
  await onWebhook(app, hook({ name: 'דני', messages: [text('wamid.a', 'היי')] }));
  const lead = db.get('SELECT * FROM leads WHERE mobile = ?', DANI);
  setNow(SUNDAY + 60_000);
  assert.ok((await reply(app, lead, 'אני אבי מעל הקו, איך אפשר לעזור?')).ok);
  setNow(SUNDAY + 120_000);
  await onWebhook(app, hook({ name: 'דני', messages: [text('wamid.b', 'רציתי לשאול על המחיר')] }));
  assert.deepEqual(toran.calls[1].body.operator.map((o) => o.text), ['אני אבי מעל הקו, איך אפשר לעזור?']);
  assert.deepEqual(out(db).map((m) => m.kind), ['bot', 'reply']);
  setNow(SUNDAY + 13 * HOUR);
  await onWebhook(app, hook({ name: 'דני', messages: [text('wamid.c', 'עוד שאלה')] }));
  assert.deepEqual(toran.calls[2].body.operator, []);
  assert.deepEqual(out(db).map((m) => m.kind), ['bot', 'reply', 'bot']);
});

test('they want to join: a customer, the amount and the transfer details right after Toran\'s answer, and the admin told', async () => {
  const toran = fakeToran([{ reply: 'מעולה. פרטי התשלום מגיעים בהודעה הבאה.', handoff: { reason: 'join', summary: 'רוצה להצטרף', business: 'דני חשמל' } }, { reply: 'קיבלנו' }]);
  const { app, db, graph } = testApp({ env: TORAN_ENV, toranFetch: toran.f });
  await onWebhook(app, hook({ name: 'דני', messages: [text('wamid.a', 'אני רוצה להצטרף, דני חשמל')] }));
  const c = db.get('SELECT * FROM customers WHERE phone = ?', DANI);
  assert.equal(c.business, 'דני חשמל');
  assert.equal(c.name, 'דני');
  assert.equal(c.status, 'setup');
  const lead = db.get('SELECT * FROM leads WHERE mobile = ?', DANI);
  assert.equal(lead.closed_why, 'customer');
  assert.equal(c.lead_id, lead.id);
  const sent = out(db);
  assert.deepEqual(sent.map((m) => m.kind), ['bot', 'pay']);
  assert.match(sent[1].body, /175\.82 ₪ כולל מע״מ/);
  assert.match(sent[1].body, /על שם ישראל ישראלי/);
  assert.equal(graph.sent().length, 2);
  const join = toran.alerts.find((a) => a.key.startsWith('join:'));
  assert.match(join.title, /דני חשמל, 052-999-8877 רוצים להצטרף, ופרטי התשלום נשלחו אליהם/);
  assert.match(join.body, /\/admin\/customers\/\d+/);
  // Now a customer: Toran is told so, and a second "join" within six hours sends the details once.
  toran.answers.push({ reply: 'שלחתי שוב', handoff: { reason: 'join', summary: 'שוב', business: 'דני חשמל' } });
  await onWebhook(app, hook({ name: 'דני', messages: [text('wamid.b', 'העברתי?')] }));
  await onWebhook(app, hook({ name: 'דני', messages: [text('wamid.c', 'אפשר שוב את הפרטים?')] }));
  assert.match(toran.calls[1].body.context, /A customer of על הקו: business "דני חשמל"/);
  assert.match(toran.calls[1].body.context, /have not paid their first month yet \(175\.82 ₪ with VAT\)/);
  assert.match(toran.calls[1].body.context, /We sent them the amount and the transfer details/);
  assert.equal(out(db).filter((m) => m.kind === 'pay').length, 1);
  assert.equal(db.get('SELECT count(*) AS n FROM customers').n, 1);
});

test('the transfer\'s picture after joining becomes a receipt, and the admin is told to check the bank', async () => {
  const toran = fakeToran([{ reply: 'פרטי התשלום בהודעה הבאה', handoff: { reason: 'join', summary: 'רוצה להצטרף', business: 'דני חשמל' } }]);
  const { app, db, graph } = testApp({ env: TORAN_ENV, toranFetch: toran.f });
  await onWebhook(app, hook({ name: 'דני', messages: [text('wamid.a', 'רוצה להתחיל')] }));
  graph.media['media.1'] = { mime: 'image/png', bytes: Buffer.from('89504e470d0a1a0a0000000d4948445200000001', 'hex') };
  await onWebhook(app, hook({ name: 'דני', messages: [{ id: 'wamid.p', from: DANI, type: 'image', image: { id: 'media.1', mime_type: 'image/png' } }] }));
  const r = db.get('SELECT * FROM receipts');
  assert.ok(r);
  const alert = toran.alerts.find((a) => a.key === `receipt:${r.id}`);
  assert.match(alert.title, /דני חשמל, 052-999-8877 שלחו צילום של העברה/);
  assert.match(alert.body, new RegExp(`/admin/receipts/${r.id}`));
  assert.equal(toran.calls.length, 1); // the picture never went to Toran
});

test('a join from a number that cannot be a customer: nothing sent, and the admin is told why', async () => {
  const toran = fakeToran([{ reply: 'פרטי התשלום בהודעה הבאה', handoff: { reason: 'join', summary: 'רוצה להצטרף', business: 'X' } }]);
  const { app, db } = testApp({ env: TORAN_ENV, toranFetch: toran.f });
  await onWebhook(app, hook({ name: 'Joe', messages: [text('wamid.a', 'I want to join', '447700900123')] }));
  assert.equal(db.get('SELECT count(*) AS n FROM customers').n, 0);
  const a = toran.alerts.find((x) => x.key.startsWith('join:'));
  assert.match(a.title, /רוצים להצטרף, אבל פרטי התשלום לא נשלחו/);
  assert.match(a.body, /לא נייד ישראלי/);
});

test('another handoff tells the admin; "stop" in other words stops us; another bot is left alone', async () => {
  const toran = fakeToran([
    { reply: 'העברתי לנציג שלנו', handoff: { reason: 'complaint', summary: 'לא מרוצה מהסיכומים' } },
    { reply: null, handoff: { reason: 'bot', summary: 'בוט' } },
    { reply: null, handoff: { reason: 'stop', summary: 'ביקש שנפסיק' } },
  ]);
  const { app, db } = testApp({ env: TORAN_ENV, toranFetch: toran.f });
  await onWebhook(app, hook({ name: 'דני', messages: [text('wamid.a', 'הסיכומים שלכם גרועים')] }));
  const h = toran.alerts.find((a) => a.key.startsWith('handoff:'));
  assert.match(h.title, /תורן העביר אליך את דני, 052-999-8877/);
  assert.match(h.body, /לא מרוצה מהסיכומים/);
  await onWebhook(app, hook({ name: 'Bot', messages: [text('wamid.x', 'בחר 1 למכירות או 2 לשירות', '972521112233')] }));
  assert.equal(toran.alerts.filter((a) => a.key.startsWith('handoff:')).length, 1);
  assert.equal(out(db, '972521112233').length, 0);
  await onWebhook(app, hook({ name: 'דני', messages: [text('wamid.b', 'זה לא בשבילי, תמחקו את המספר שלי')] }));
  assert.ok(db.get('SELECT 1 FROM stops WHERE phone = ?', DANI));
  assert.equal(db.get('SELECT closed_why FROM leads WHERE mobile = ?', DANI).closed_why, 'stopped');
  // Stopped: whatever they write next never goes to Toran.
  await onWebhook(app, hook({ name: 'דני', messages: [text('wamid.c', 'רגע, דווקא כן')] }));
  assert.equal(toran.calls.filter((c) => c.body.phone === DANI).length, 2);
});

test('"כן, שלחו" and "לא, תודה" stay ours: the explanation or the stop, never Toran; "כן" tells the admin', async () => {
  const toran = fakeToran([{ reply: 'אפשר להתחיל מתי שתרצו' }]);
  const { app, db } = testApp({ env: TORAN_ENV, toranFetch: toran.f });
  const lead = addLead(db);
  assert.ok((await sendPitch(app, lead, 'first')).ok);
  await onWebhook(app, hook({ messages: [{ id: 'wamid.y', from: lead.mobile, type: 'button', button: { text: 'כן, שלחו' } }] }));
  assert.equal(toran.calls.length, 0);
  assert.equal(out(db, lead.mobile).at(-1).kind, 'pitch');
  assert.match(toran.alerts[0].title, /ביקשו את ההסבר/);
  // A question after the explanation is Toran's, with who they are.
  await onWebhook(app, hook({ messages: [text('wamid.q', 'מה צריך כדי להתחיל?', lead.mobile)] }));
  assert.match(toran.calls[0].body.context, /A tradesperson we wrote to first \(אבי אינסטלציה\)[\s\S]*said yes and already got our explanation/);
  const other = addLead(db, 'plumber', { mobile: '972541110000', domain: 'other' });
  assert.ok((await sendPitch(app, other, 'first')).ok);
  await onWebhook(app, hook({ messages: [{ id: 'wamid.n', from: other.mobile, type: 'button', button: { text: 'לא, תודה' } }] }));
  assert.equal(toran.calls.length, 1);
});
