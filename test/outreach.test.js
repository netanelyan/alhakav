import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { DAY, HOUR, now, setNow } from '../server/clock.js';
import { countsNew, countsReached, funnel, listReached, purgeLeads } from '../server/leads.js';
import { forgetQuality, markByHand, messageText, onWebhook, reminderDue, reply, sendPitch } from '../server/outreach.js';
import { forgetTemplates } from '../server/meta.js';
import { ENV, addLead, hook, testApp } from './helpers.js';

const SUNDAY = Date.parse('2026-11-22T08:00:00Z'); // Sunday 10:00 in Israel
const leadOf = (db, id) => db.get('SELECT * FROM leads WHERE id = ?', id);
const msgs = (db, id) => db.all('SELECT * FROM messages WHERE lead_id = ? ORDER BY id', id);

beforeEach(() => {
  setNow(SUNDAY);
  forgetQuality();
});
afterEach(() => setNow(null));

test('the first message goes as the approved template, with the name, and moves the lead to the ones we wrote to', async () => {
  const { app, db, graph } = testApp();
  const lead = addLead(db);
  const r = await sendPitch(app, lead, 'first');
  assert.ok(r.ok, r.flash);
  const send = graph.sent()[0];
  assert.equal(send.url, 'https://graph.test/v23.0/123/messages');
  assert.equal(send.body.to, '972541234567');
  assert.equal(send.body.template.name, 'alhakav_page');
  assert.deepEqual(send.body.template.components[0].parameters, [{ type: 'text', text: 'אצל אבי אינסטלציה' }]);
  // The button opens their own page.
  const code = leadOf(db, lead.id).page_code;
  assert.match(code, /^[a-z0-9]{10}$/);
  assert.deepEqual(send.body.template.components[1], { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] });
  const x = leadOf(db, lead.id);
  assert.equal(x.stage, 'waiting');
  assert.equal(x.out_state, 'sent');
  assert.equal(x.out_by, 'meta');
  const [m] = msgs(db, lead.id);
  assert.equal(m.kind, 'first');
  assert.equal(m.wa_id, 'wamid.1');
  assert.match(m.body, /הכנו דף קצר שמראה איך זה ייראה אצל אבי אינסטלציה\./);
  assert.match(m.body, /ישראל ישראלי/);
  assert.deepEqual(countsNew(db), { all: 0, fit: 0, below: 0 });
  assert.equal(countsReached(db).waiting, 1);
  // Once is all.
  const again = await sendPitch(app, x, 'first');
  assert.ok(!again.ok);
  assert.equal(graph.sent().length, 1);
});

test("the first message opens with a moment from their trade once Meta approved that template, and until then as before", async () => {
  forgetTemplates();
  const { app, db, graph } = testApp({ env: { ...ENV, META_WABA_ID: 'waba' } });
  const lead = addLead(db);
  db.run("UPDATE leads SET trade = 'electrician' WHERE id = ?", addLead(db, 'plumber', { mobile: '972501112233', domain: 'eli' }).id);
  const electrician = db.get("SELECT * FROM leads WHERE domain = 'eli.example'");
  graph.templates.alhakav_page_trade = 'PENDING';
  assert.ok((await sendPitch(app, lead, 'first')).ok);
  assert.equal(graph.sent().at(-1).body.template.name, 'alhakav_page');
  assert.match(msgs(db, lead.id)[0].body, /^שלום, כאן על הקו\. כשאתם באמצע עבודה ולא עונים, מי שהתקשר/);
  // By hand it is plain text from the admin's phone, so it is in their trade's words already.
  assert.match(messageText('first', electrician, app.env, { byHand: true }), /^👋 שלום, כאן \*על הקו\*\.\n\n📞 כשאתם על סולם מול לוח חשמל ולא עונים, מי שהתקשר/);
  // Approved: it takes over by itself, with the moment as {{1}} and the name as {{2}}.
  forgetTemplates();
  graph.templates.alhakav_page_trade = 'APPROVED';
  assert.ok((await sendPitch(app, electrician, 'first')).ok);
  const t = graph.sent().at(-1).body.template;
  assert.equal(t.name, 'alhakav_page_trade');
  assert.deepEqual(t.components[0].parameters.map((p) => p.text), ['כשאתם על סולם מול לוח חשמל ולא עונים', `אצל ${leadOf(db, electrician.id).name}`]);
  assert.match(msgs(db, electrician.id)[0].body, /^👋 שלום, כאן \*על הקו\*\.\n\n📞 כשאתם על סולם מול לוח חשמל ולא עונים, מי שהתקשר מקבל מאיתנו/);
  // What the admin's page shows now is the same words.
  assert.match(messageText('first', leadOf(db, electrician.id), app.env), /כשאתם על סולם מול לוח חשמל/);
  forgetTemplates();
});

test('the guardrails: the daily cap, quiet hours, the quality rating, and a lead with no mobile', async () => {
  const { app, db, graph } = testApp();
  const a = addLead(db, 'plumber', { domain: 'a', mobile: '972501111111' });
  const b = addLead(db, 'plumber', { domain: 'b', mobile: '972502222222' });
  const c = addLead(db, 'plumber', { domain: 'c', mobile: '972503333333' });
  assert.ok((await sendPitch(app, a, 'first')).ok);
  assert.ok((await sendPitch(app, b, 'first')).ok);
  const capped = await sendPitch(app, c, 'first');
  assert.ok(!capped.ok);
  assert.match(capped.flash, /המקסימום ליום/);

  setNow(Date.parse('2026-11-21T10:00:00Z')); // Saturday
  const q = await sendPitch(app, c, 'first');
  assert.match(q.flash, /שבת/);
  assert.match(q.flash, /מחר ב־09:00/);

  setNow(Date.parse('2026-11-23T08:00:00Z')); // Monday: a new day, a new cap
  graph.quality = 'YELLOW';
  forgetQuality();
  const yellow = await sendPitch(app, c, 'first');
  assert.match(yellow.flash, /YELLOW/);
  graph.quality = 'GREEN';
  forgetQuality();
  assert.ok((await sendPitch(app, c, 'first')).ok);

  db.run('UPDATE leads SET mobile = NULL WHERE id = ?', a.id);
  const none = await sendPitch(app, leadOf(db, a.id), 'reminder');
  assert.match(none.flash, /אין נייד/);
});

test('one reminder, four days on, only while they have not answered', async () => {
  const { app, db, graph } = testApp();
  const lead = addLead(db);
  await sendPitch(app, lead, 'first');
  setNow(SUNDAY + 3 * DAY);
  assert.ok(!reminderDue(leadOf(db, lead.id)));
  const early = await sendPitch(app, leadOf(db, lead.id), 'reminder');
  assert.match(early.flash, /התזכורת האחת תהיה מוכנה/);
  setNow(SUNDAY + 4 * DAY + HOUR);
  assert.ok(reminderDue(leadOf(db, lead.id)));
  assert.ok((await sendPitch(app, leadOf(db, lead.id), 'reminder')).ok);
  assert.equal(graph.sent().at(-1).body.template.name, 'alhakav_page_reminder_v2');
  assert.ok(!(await sendPitch(app, leadOf(db, lead.id), 'reminder')).ok);
});

test('statuses move how far it got forward, never back', async () => {
  const { app, db } = testApp();
  const lead = addLead(db);
  await sendPitch(app, lead, 'first');
  await onWebhook(app, hook({ statuses: [{ id: 'wamid.1', status: 'delivered', recipient_id: '972541234567' }] }));
  assert.equal(leadOf(db, lead.id).out_state, 'delivered');
  await onWebhook(app, hook({ statuses: [{ id: 'wamid.1', status: 'read', recipient_id: '972541234567' }] }));
  await onWebhook(app, hook({ statuses: [{ id: 'wamid.1', status: 'delivered', recipient_id: '972541234567' }] }));
  assert.equal(leadOf(db, lead.id).out_state, 'read');
  assert.equal(msgs(db, lead.id)[0].status, 'read');
});

test('a number with no WhatsApp: the status says it never arrived', async () => {
  const { app, db } = testApp();
  const lead = addLead(db);
  await sendPitch(app, lead, 'first');
  await onWebhook(app, hook({ statuses: [{ id: 'wamid.1', status: 'failed', recipient_id: '972541234567', errors: [{ code: 131026, title: 'Message undeliverable' }] }] }));
  assert.equal(leadOf(db, lead.id).out_state, 'undelivered');
  assert.match(msgs(db, lead.id)[0].error, /אין וואטסאפ/);
  assert.equal(funnel(db).undelivered, 1);
  setNow(SUNDAY + 5 * DAY);
  assert.ok(!reminderDue(leadOf(db, lead.id)), 'no reminder to a number the first never reached');
  assert.match((await sendPitch(app, leadOf(db, lead.id), 'reminder')).flash, /לא הגיעה אליהם/);
});

test('"כן, שלחו" gets the explanation at once, and a webhook sent twice sends it once', async () => {
  const { app, db, graph } = testApp();
  const lead = addLead(db);
  await sendPitch(app, lead, 'first');
  const yes = hook({ messages: [{ id: 'wamid.in1', from: '972541234567', timestamp: String(SUNDAY / 1000 + 600), type: 'button', button: { text: 'כן, שלחו', payload: 'כן, שלחו' } }] });
  await onWebhook(app, yes);
  await onWebhook(app, yes);
  const x = leadOf(db, lead.id);
  assert.equal(x.stage, 'talking');
  assert.equal(x.out_state, 'yes');
  assert.ok(x.yes_at);
  const texts = graph.sent().filter((c) => c.body.type === 'text');
  assert.equal(texts.length, 1);
  assert.match(texts[0].body.text.body, /\*149 ₪ לחודש\*, לא כולל מע״מ/);
  assert.match(texts[0].body.text.body, /https:\/\/alhakav\.example/);
  assert.deepEqual(msgs(db, lead.id).map((m) => m.kind), ['first', 'in', 'pitch']);
  assert.equal(funnel(db).yes, 1);
});

test('"לא, תודה" stops us for good, says so once, and closes the lead', async () => {
  const { app, db, graph } = testApp();
  const lead = addLead(db);
  await sendPitch(app, lead, 'first');
  await onWebhook(app, hook({ messages: [{ id: 'wamid.in2', from: '972541234567', type: 'button', button: { text: 'לא, תודה' } }] }));
  await onWebhook(app, hook({ messages: [{ id: 'wamid.in3', from: '972541234567', type: 'text', text: { body: 'מהר הסר' } }] }));
  const x = leadOf(db, lead.id);
  assert.equal(x.stage, 'closed');
  assert.equal(x.closed_why, 'stopped');
  assert.equal(x.out_state, 'stopped');
  assert.ok(db.get('SELECT 1 FROM stops WHERE phone = ?', '972541234567'));
  assert.equal(graph.sent().filter((c) => c.body.type === 'text').length, 1, 'the line after a stop goes once');
  setNow(SUNDAY + 5 * DAY);
  const r = await sendPitch(app, leadOf(db, lead.id), 'reminder');
  assert.ok(!r.ok);
});

test('an answer opens 24 hours to reply from the page; an away message counts for nothing', async () => {
  const { app, db, graph } = testApp();
  const lead = addLead(db);
  await sendPitch(app, lead, 'first');
  await onWebhook(app, hook({ messages: [{ id: 'wamid.a', from: '972541234567', type: 'text', text: { body: 'תודה על פנייתך, נחזור אליך בהקדם' } }] }));
  let x = leadOf(db, lead.id);
  assert.equal(x.replied_at, null);
  assert.equal(x.stage, 'waiting');
  // A greeting their WhatsApp sends by itself, in words of its own, a second after ours, is not them either.
  const second = String(Math.floor(now() / 1000) + 1);
  await onWebhook(app, hook({ messages: [{ id: 'wamid.g', from: '972541234567', timestamp: second, type: 'text', text: { body: 'Eshelhamizug.co.il אשל המיזוג - שלום לך ?' } }] }));
  x = leadOf(db, lead.id);
  assert.equal(x.replied_at, null);
  assert.equal(db.get("SELECT kind FROM messages WHERE wa_id = 'wamid.g'").kind, 'auto');
  await onWebhook(app, hook({ messages: [{ id: 'wamid.b', from: '972541234567', type: 'text', text: { body: 'כמה זה עולה בדיוק?' } }] }));
  x = leadOf(db, lead.id);
  assert.equal(x.stage, 'talking');
  assert.equal(x.out_state, 'replied');
  assert.ok((await reply(app, x, '149 ₪ לחודש, לא כולל מע״מ.')).ok);
  assert.equal(graph.sent().at(-1).body.text.body, '149 ₪ לחודש, לא כולל מע״מ.');
  setNow(SUNDAY + 25 * HOUR);
  const late = await reply(app, leadOf(db, lead.id), 'עוד משהו');
  assert.ok(!late.ok);
  assert.match(late.flash, /24 שעות/);
  assert.equal(listReached(db, { tab: 'talking' }).length, 1);
});

test('someone who writes to the business number becomes a lead', async () => {
  const { app, db } = testApp();
  await onWebhook(app, hook({ name: 'דני', messages: [{ id: 'wamid.n', from: '972529998877', type: 'text', text: { body: 'היי, ראיתי את האתר ואני רוצה לנסות' } }] }));
  const x = db.get('SELECT * FROM leads WHERE mobile = ?', '972529998877');
  assert.equal(x.name, 'דני');
  assert.equal(x.source, 'whatsapp');
  assert.equal(x.stage, 'talking');
});

test('without Meta set up, the message is copied to the phone and marked by hand', async () => {
  const { app, db, graph } = testApp({ env: { ...ENV, META_TOKEN: '' } });
  const lead = addLead(db);
  const r = await sendPitch(app, lead, 'first');
  assert.ok(!r.ok);
  assert.match(r.flash, /META_TOKEN/);
  assert.match(messageText('first', lead, app.env, { byHand: true }), /עונים "לא"/);
  assert.ok(markByHand(app, lead, 'first').ok);
  const x = leadOf(db, lead.id);
  assert.equal(x.out_by, 'hand');
  assert.equal(x.stage, 'waiting');
  assert.equal(graph.sent().length, 0);
  // "לא" typed back to a message sent by hand stops us too.
  await onWebhook(app, hook({ messages: [{ id: 'wamid.no', from: '972541234567', type: 'text', text: { body: 'לא' } }] }));
  assert.equal(leadOf(db, lead.id).closed_why, 'stopped');
});

test('a lead that is not a customer is deleted six months after anything last happened, and is never found again', () => {
  const { db } = testApp();
  const old = addLead(db, 'plumber', { domain: 'old', mobile: '972501010101' });
  const fresh = addLead(db, 'plumber', { domain: 'fresh', mobile: '972502020202' });
  const customer = addLead(db, 'plumber', { domain: 'customer', mobile: '972503030303' });
  db.run("UPDATE leads SET stage = 'closed', closed_why = 'customer' WHERE id = ?", customer.id);
  db.run('UPDATE leads SET updated_at = ? WHERE id IN (?, ?)', '2026-04-01T00:00:00.000Z', old.id, customer.id);
  db.run("INSERT INTO messages (lead_id, phone, dir, kind, body, day, at) VALUES (?, ?, 'out', 'first', 'x', '2026-04-01', '2026-04-01T00:00:00.000Z')", old.id, old.mobile);
  assert.equal(purgeLeads(db, 6, SUNDAY), 1);
  assert.equal(leadOf(db, old.id), undefined);
  assert.equal(msgs(db, old.id).length, 0, 'its messages go with it');
  assert.ok(leadOf(db, fresh.id));
  assert.ok(leadOf(db, customer.id), 'a customer is kept');
  assert.equal(db.get('SELECT status FROM seen WHERE domain = ?', old.domain).status, 'expired');
});

test('"ביקשו שלא נכתוב להם" on the page stops the number like "לא, תודה" does', async () => {
  const { app, db } = testApp();
  const lead = addLead(db);
  const { stopLead } = await import('../server/leads.js');
  stopLead(db, lead);
  assert.ok(db.get('SELECT 1 FROM stops WHERE phone = ?', lead.mobile));
  assert.equal(leadOf(db, lead.id).closed_why, 'stopped');
  const r = await sendPitch(app, leadOf(db, lead.id), 'first');
  assert.ok(!r.ok);
  assert.match(r.flash, /ביקשו להסיר/);
});
