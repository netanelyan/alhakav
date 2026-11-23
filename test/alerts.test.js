import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { alertOwner, alertText, ownerNumber, updateTemplates } from '../server/alerts.js';
import { forgetTemplates, metaSettings, pickTemplate } from '../server/meta.js';
import { nowIso, setNow } from '../server/clock.js';
import { digestTick } from '../server/digest.js';
import { forgetQuality, onWebhook, sendPitch } from '../server/outreach.js';
import { ENV, addLead, fakeToran, hook, testApp } from './helpers.js';

const SUNDAY = Date.parse('2026-11-22T08:00:00Z'); // 10:00 in Israel
const OWNER = '972500000123';
const OENV = { ...ENV, OWNER_WA: '050-000-0123', OF_INTERNAL_TOKEN: 't'.repeat(40), TORAN_URL: 'http://toran.test', TORAN_DEBOUNCE_MS: '0' };

beforeEach(() => {
  setNow(SUNDAY);
  forgetQuality();
});
afterEach(() => setNow(null));

const toOwner = (graph) => graph.sent().filter((c) => c.body?.to === OWNER);

test("the owner's number in any spelling, and nothing for one that is not a mobile", () => {
  assert.equal(ownerNumber({ OWNER_WA: '0500000123' }), OWNER);
  assert.equal(ownerNumber({ OWNER_WA: '+972 50-000-0123' }), OWNER);
  assert.equal(ownerNumber({ OWNER_WA: '03-1234567' }), '');
  assert.equal(ownerNumber({}), '');
});

test('an alert as the template says it: one line without links, and the button to its admin page', () => {
  const a = alertText(ENV, 'על הקו: תורן העביר אליך את דני, 052-999-8877', 'הם שילמו בהעברה.\nהדף שלהם: https://alhakav.example/admin/leads/7');
  assert.equal(a.param, 'תורן העביר אליך את דני, 052-999-8877. הם שילמו בהעברה.');
  assert.equal(a.button, 'leads/7');
  assert.ok(a.text.startsWith('🔔 *תורן העביר אליך את דני, 052-999-8877*\n'), a.text);
  assert.match(a.text, /https:\/\/alhakav\.example\/admin\/leads\/7/);
  assert.equal(alertText(ENV, 'על הקו: משהו', '').button, 'leads', 'no page: the leads');
});

test('with OWNER_WA, an alert goes from the business number as the template, once in its window, kept for the inbox', async () => {
  const toran = fakeToran();
  const { app, db, graph } = testApp({ env: OENV, toranFetch: toran.f });
  assert.equal(await alertOwner(app, 'k1', 'על הקו: מישהו כתב', 'הדף שלהם: https://alhakav.example/admin/leads/3', 60), true);
  const [sent] = toOwner(graph);
  assert.equal(sent.body.type, 'template');
  assert.equal(sent.body.template.name, 'alhakav_owner_alert_v2');
  assert.deepEqual(sent.body.template.components[0].parameters.map((p) => p.text), ['מישהו כתב', 'אין פרטים נוספים.']);
  assert.deepEqual(sent.body.template.components[1].parameters, [{ type: 'text', text: 'leads/3' }]);
  assert.equal(toran.alerts.length, 0, 'Toran is not asked');
  const kept = db.get("SELECT * FROM messages WHERE kind = 'alert'");
  assert.equal(kept.phone, OWNER);
  assert.equal(kept.lead_id, null);

  await alertOwner(app, 'k1', 'על הקו: מישהו כתב', '', 60);
  assert.equal(toOwner(graph).length, 1, 'the same key inside its hour: nothing');
  setNow(SUNDAY + 61 * 60_000);
  await alertOwner(app, 'k1', 'על הקו: מישהו כתב', '', 60);
  assert.equal(toOwner(graph).length, 2, 'after its hour: again');
});

test("while the owner's chat with the business number is open, plain text with the links", async () => {
  const { app, db, graph } = testApp({ env: OENV, toranFetch: fakeToran().f });
  db.run("INSERT INTO messages (lead_id, phone, dir, kind, body, day, at) VALUES (NULL, ?, 'in', 'in', 'היי', '2026-11-22', ?)", OWNER, new Date(SUNDAY - 3600_000).toISOString());
  await alertOwner(app, 'k2', 'על הקו: מישהו כתב', 'הדף שלהם: https://alhakav.example/admin/leads/3');
  const [sent] = toOwner(graph);
  assert.equal(sent.body.type, 'text');
  assert.equal(sent.body.text.body, '🔔 *מישהו כתב*\nהדף שלהם: https://alhakav.example/admin/leads/3');
});

test('when the business number cannot send it (the template not approved yet), Toran takes it', async () => {
  const toran = fakeToran();
  const { app, graph, logs } = testApp({ env: OENV, toranFetch: toran.f });
  graph.fail = { code: 132001, message: 'Template name does not exist in the translation' };
  assert.equal(await alertOwner(app, 'k3', 'על הקו: מישהו כתב', ''), true);
  assert.equal(toran.alerts.length, 1);
  assert.equal(toran.alerts[0].key, 'k3');
  assert.ok(logs.some((l) => /could not send it to •••0123/.test(l)));
});

test("a lead's first answer to our message tells the owner what they wrote", async () => {
  const toran = fakeToran([{ reply: 'בשמחה' }]);
  const { app, db, graph } = testApp({ env: OENV, toranFetch: toran.f });
  const lead = addLead(db);
  assert.ok((await sendPitch(app, lead, 'first')).ok);
  await onWebhook(app, hook({ messages: [{ id: 'wamid.r1', from: lead.mobile, type: 'text', text: { body: 'כמה זה עולה?' } }] }));
  const alert = toOwner(graph).find((c) => c.body.type === 'template');
  assert.match(alert.body.template.components[0].parameters[0].text, /^אבי אינסטלציה, .* ענו להודעה שלנו$/);
  assert.equal(alert.body.template.components[0].parameters[1].text, 'הם כתבו: כמה זה עולה?');
  await onWebhook(app, hook({ messages: [{ id: 'wamid.r2', from: lead.mobile, type: 'text', text: { body: 'ואיך מתחילים?' } }] }));
  assert.equal(toOwner(graph).length, 1, 'only the first answer');
});

test('the evening summary: once a date, after 19:00, only when something happened', async () => {
  const { app, db, graph } = testApp({ env: OENV, toranFetch: fakeToran().f });
  assert.equal(await digestTick(app), false, '10:00 is too early');
  setNow(Date.parse('2026-11-22T17:05:00Z')); // 19:05
  assert.equal(await digestTick(app), false, 'nothing happened');
  setNow(Date.parse('2026-11-23T17:05:00Z'));
  const lead = addLead(db);
  db.run('UPDATE leads SET created_at = ?, page_last_at = ? WHERE id = ?', nowIso(), nowIso(), lead.id);
  assert.equal(await digestTick(app), true);
  const [sent] = toOwner(graph);
  assert.deepEqual(sent.body.template.components[0].parameters.map((p) => p.text), ['מה היה ב־24 השעות האחרונות', 'מצאתי בעל מקצוע אחד שמתאים ועסק אחד פתח את הדף שלו.']);
  assert.equal(sent.body.template.components[1].parameters[0].text, 'inbox');
  assert.equal(await digestTick(app), false, 'once a date');
});

test("the owner writing to the business number: kept, never answered by the bot, and \"סיכום\" gets the day", async () => {
  const toran = fakeToran();
  const { app, db, graph } = testApp({ env: OENV, toranFetch: toran.f });
  await onWebhook(app, hook({ messages: [{ id: 'wamid.o1', from: OWNER, type: 'text', text: { body: 'תודה' } }] }));
  await onWebhook(app, hook({ messages: [{ id: 'wamid.o2', from: OWNER, type: 'text', text: { body: 'די' } }] }));
  assert.equal(toran.calls.length, 0, 'Toran is not asked');
  assert.equal(toOwner(graph).length, 0, 'nothing is answered');
  assert.equal(db.get('SELECT count(*) AS n FROM leads').n, 0, 'the owner is no lead');
  assert.equal(db.get('SELECT count(*) AS n FROM stops').n, 0, '"די" from the owner stops nothing');
  assert.equal(db.get("SELECT count(*) AS n FROM messages WHERE phone = ? AND dir = 'in' AND kind = 'owner'", OWNER).n, 2);

  await onWebhook(app, hook({ messages: [{ id: 'wamid.o3', from: OWNER, type: 'text', text: { body: 'סיכום' } }] }));
  const [sent] = toOwner(graph);
  assert.equal(sent.body.type, 'text', 'they just wrote: plain text');
  assert.equal(sent.body.text.body, '🔔 *מה היה ב־24 השעות האחרונות*\nלא קרה שום דבר חדש ב־24 השעות האחרונות.');
});

test('the reworded template goes once Meta approves it as Utility; until then the approved one', async () => {
  const env = { ...OENV, META_WABA_ID: 'waba' };
  const run = async (templates) => {
    forgetTemplates();
    const { app, graph } = testApp({ env, toranFetch: fakeToran().f });
    Object.assign(graph.templates, templates);
    await alertOwner(app, `k-${Math.random()}`, 'על הקו: מישהו כתב', 'הם שאלו כמה זה עולה.\nהדף שלהם: https://alhakav.example/admin/leads/3');
    return toOwner(graph)[0].body.template;
  };
  let t = await run({ alhakav_owner_alert: { status: 'PENDING', category: 'UTILITY' }, alhakav_update: { status: 'APPROVED', category: 'MARKETING' } });
  assert.equal(t.name, 'alhakav_update');
  assert.deepEqual(t.components[0].parameters.map((p) => p.text), ['מישהו כתב. הם שאלו כמה זה עולה.']);
  t = await run({ alhakav_owner_alert: { status: 'APPROVED', category: 'UTILITY' }, alhakav_update: { status: 'APPROVED', category: 'MARKETING' } });
  assert.equal(t.name, 'alhakav_owner_alert');
  assert.deepEqual(t.components[0].parameters.map((p) => p.text), ['מישהו כתב', 'הם שאלו כמה זה עולה.']);
  // The one in the look of every message, once approved, with the same two.
  t = await run({ alhakav_owner_alert_v2: { status: 'APPROVED', category: 'UTILITY' }, alhakav_owner_alert: { status: 'APPROVED', category: 'UTILITY' } });
  assert.equal(t.name, 'alhakav_owner_alert_v2');
  assert.deepEqual(t.components[0].parameters.map((p) => p.text), ['מישהו כתב', 'הם שאלו כמה זה עולה.']);
  // Meta could not be asked about any of them: the oldest, which went before.
  forgetTemplates();
  const down = async (url) => (String(url).includes('message_templates') ? Promise.reject(new Error('down')) : Response.json({}));
  assert.equal(await pickTemplate(metaSettings(env), down, updateTemplates(env)), 'alhakav_update');
  forgetTemplates();
});
