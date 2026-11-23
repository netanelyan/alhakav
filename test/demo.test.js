import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { afterEach, beforeEach, test } from 'node:test';
import { handler } from '../server/app.js';
import { setNow } from '../server/clock.js';
import { DEMO_PER_PAGE, SAMPLE, codeIn, pageCodeOf, pageHtml } from '../server/demo.js';
import { forgetQuality, onWebhook, sendPitch } from '../server/outreach.js';
import { settle } from '../server/service.js';
import { ENV, addLead, fakeToran, hook, testApp } from './helpers.js';

const SUNDAY = Date.parse('2026-11-22T08:00:00Z');
const ASSIST = '456';
const DENV = { ...ENV, ASSIST_PHONE_ID: ASSIST, ASSIST_NUMBER: '972552735207', REPLY_DELAY_MS: '0', OF_INTERNAL_TOKEN: 't'.repeat(40), TORAN_URL: 'http://toran.test', TORAN_DEBOUNCE_MS: '0' };

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

beforeEach(() => {
  setNow(SUNDAY);
  forgetQuality();
});
afterEach(() => setNow(null));

const toAssist = (app, from, text, id) => onWebhook(app, hook({ phoneId: ASSIST, messages: [{ id, from, type: 'text', text: { body: text } }] }));

test("a lead's page: their name, an example from their trade and city, the try and the talk buttons, never indexed", async () => {
  const toran = fakeToran();
  const { app, db } = testApp({ env: DENV, toranFetch: toran.f });
  const lead = addLead(db);
  db.run("UPDATE leads SET trade = 'electrician', city = 'אשדוד' WHERE id = ?", lead.id);
  const code = pageCodeOf(db, db.get('SELECT * FROM leads WHERE id = ?', lead.id));
  assert.match(code, /^[a-z0-9]{10}$/);
  assert.equal(pageCodeOf(db, db.get('SELECT * FROM leads WHERE id = ?', lead.id)), code, 'one code a lead');
  const html = pageHtml(app.env, db.get('SELECT * FROM leads WHERE id = ?', lead.id));
  assert.match(html, /בשביל אבי אינסטלציה/);
  assert.match(html, /קפץ החשמל במטבח/, 'the electrician example');
  assert.match(html, /ויצמן 8 אשדוד/, 'their city');
  assert.match(html, /שלום, כאן העוזר של אבי אינסטלציה/);
  assert.match(html, new RegExp(`wa\\.me/972552735207\\?text=[^"]*${code}`), 'the try goes to המוקדן with the code');
  assert.match(html, /wa\.me\/972515310498/, 'the talk button goes to the business number');
  assert.match(html, /name="robots" content="noindex/);
  // Who writes to them, small at the bottom, and only there.
  assert.ok(html.includes('<p class="who">על הקו, ישראל ישראלי, רחוב הדוגמה 1, אשדוד. alhakav.example</p></div></footer>'));
  assert.equal(html.split('ישראל ישראלי').length, 2);
  assert.doesNotMatch(pageHtml({ ...app.env, SENDER_LINE: '' }, db.get('SELECT * FROM leads WHERE id = ?', lead.id)), /class="who"/);

  const server = createServer(handler(app));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const r = await fetch(`${base}/p/${code}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-robots-tag'), 'noindex, nofollow');
    await fetch(`${base}/p/${code}`);
    assert.equal((await fetch(`${base}/p/zzzzzzzzzz`)).status, 404);
    assert.equal((await fetch(`${base}/svg/al-hakav-mokdan-avatar.svg`)).status, 200);
  } finally {
    server.close();
  }
  const x = db.get('SELECT page_views, page_first_at FROM leads WHERE id = ?', lead.id);
  assert.equal(x.page_views, 2);
  assert.ok(x.page_first_at);
  const seen = toran.alerts.filter((a) => a.key === `page:${lead.id}`);
  assert.equal(seen.length, 2, 'each view asks; Toran says it once a day');
  assert.match(seen[0].title, /אבי אינסטלציה פתחו את הדף שלהם/);
});

test('"כן, שלחו" sends their page, and Toran knows it', async () => {
  const toran = fakeToran([{ reply: 'אפשר להתחיל מתי שתרצו' }]);
  const { app, db, graph } = testApp({ env: DENV, toranFetch: toran.f });
  const lead = addLead(db);
  assert.ok((await sendPitch(app, lead, 'first')).ok);
  await onWebhook(app, hook({ messages: [{ id: 'wamid.y', from: lead.mobile, type: 'button', button: { text: 'כן, שלחו' } }] }));
  const code = db.get('SELECT page_code FROM leads WHERE id = ?', lead.id).page_code;
  const pitch = graph.sent().at(-1).body.text.body;
  assert.match(pitch, /הכנו דף קטן רק בשביל אבי אינסטלציה/);
  assert.ok(pitch.includes(`https://alhakav.example/p/${code}`));
  assert.match(pitch, /לנסות את זה על עצמכם/);
  await onWebhook(app, hook({ messages: [{ id: 'wamid.q', from: lead.mobile, type: 'text', text: { body: 'כמה זמן לוקח להתחיל?' } }] }));
  assert.ok(toran.calls[0].body.context.includes(`/p/${code}`));
});

test('the try: המוקדן plays their own assistant, and at the end the summary they would get comes to them', async () => {
  const toran = fakeToran();
  const claude = fakeClaude([
    { reply: 'מה הכתובת?', done: false, what: 'נזילה מתחת לכיור', place: '', urgency: '' },
    { reply: 'תודה, הפרטים אצל אבי אינסטלציה והם יחזרו אליך כשיתפנו.', done: true, what: 'נזילה מתחת לכיור', place: 'הרצל 3, אשדוד', urgency: 'דחוף' },
  ]);
  const { app, db, graph } = testApp({ env: DENV, toranFetch: toran.f });
  app.claude = claude;
  const lead = addLead(db);
  const code = pageCodeOf(db, lead);
  const ME = '972541234567';
  const sent = () => graph.sent().filter((c) => c.url.endsWith(`/${ASSIST}/messages`) && c.body.to === ME).map((c) => c.body.text.body);
  assert.equal(codeIn(`אני רוצה לנסות (${code})`), code);
  await toAssist(app, ME, `אני רוצה לנסות (${code})`, 'd1');
  assert.match(sent()[0], /עכשיו אתם הלקוח: נגיד שהתקשרתם לאבי אינסטלציה/);
  assert.match(sent()[1], /שלום, כאן העוזר של אבי אינסטלציה/);
  assert.match(toran.alerts.find((a) => a.key === `demo:${lead.id}`).title, /אבי אינסטלציה מנסים את המוקדן/);
  await toAssist(app, ME, 'יש נזילה מתחת לכיור', 'd2');
  await settle(app);
  assert.equal(sent()[2], 'מה הכתובת?');
  assert.match(claude.seen[0].system[0].text, /"אבי אינסטלציה"/);
  await toAssist(app, ME, 'הרצל 3 אשדוד, זה דחוף', 'd3');
  await settle(app);
  const out = sent();
  assert.match(out.at(-2), /וזה מה שהיה מגיע אליכם לוואטסאפ:[\s\S]*\*מה:\* נזילה מתחת לכיור[\s\S]*\*איפה:\* הרצל 3, אשדוד[\s\S]*\*טלפון:\* 054-123-4567/);
  assert.match(out.at(-1), /\*רוצים את זה על המספר שלכם\?\* כתבו לנו כאן: https:\/\/wa\.me\/972515310498/);
  assert.equal(db.get('SELECT state FROM demos').state, 'done');
  // Done: what they write next is not the try any more, and the same webhook again starts nothing.
  await toAssist(app, ME, `אני רוצה לנסות (${code})`, 'd1');
  assert.equal(db.get('SELECT count(*) AS n FROM demos').n, 1);
});

test("a customer's command is theirs even in a try they left open, and ends it", async () => {
  const claude = fakeClaude([{ reply: 'מה הכתובת?', done: false, what: 'נזילה', place: '', urgency: '' }]);
  const { app, db, graph } = testApp({ env: DENV, toranFetch: fakeToran().f });
  app.claude = claude;
  const lead = addLead(db);
  const ME = '972541234567';
  const sent = () => graph.sent().filter((c) => c.url.endsWith(`/${ASSIST}/messages`) && c.body.to === ME).map((c) => c.body.text.body);
  // They tried it on their page and left it midway, then joined and got their codes.
  await toAssist(app, ME, `אני רוצה לנסות (${pageCodeOf(db, lead)})`, 'd1');
  await toAssist(app, ME, 'יש נזילה', 'd2');
  await settle(app);
  db.run("INSERT INTO customers (name, business, trade, phone, assistant, status, created_at, updated_at) VALUES ('אבי', 'אבי אינסטלציה', 'plumber', ?, '97243763891', 'active', '2026-11-22', '2026-11-22')", ME);
  await toAssist(app, ME, 'לא לשלוח 0509998877', 'd3');
  await settle(app);
  assert.equal(db.get("SELECT count(*) AS n FROM skips WHERE phone = '972509998877'").n, 1);
  assert.match(sent().at(-1), /050-999-8877 לא יקבל ממני הודעות/);
  assert.equal(db.get('SELECT state FROM demos').state, 'done');
  assert.equal(claude.seen.length, 1, 'the command never reached the try');
});

test('the try has limits: a few a day for one page', async () => {
  const { app, db, graph } = testApp({ env: DENV, toranFetch: fakeToran().f });
  const lead = addLead(db);
  const code = pageCodeOf(db, lead);
  for (let i = 0; i < DEMO_PER_PAGE + 1; i++) await toAssist(app, '972501110001', `אני רוצה לנסות (${code})`, `t${i}`);
  assert.equal(db.get('SELECT count(*) AS n FROM demos').n, DEMO_PER_PAGE);
  assert.match(graph.sent().at(-1).body.text.body, /הרבה מנסים היום/);
});

test('the sample page /p/demo: a made-up business in each trade, said to be a sample, never counted', async () => {
  const { app, db } = testApp({ env: DENV, toranFetch: fakeToran().f });
  const server = createServer(handler(app));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const r = await fetch(`${base}/p/demo`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-robots-tag'), 'noindex, nofollow');
    const html = await r.text();
    assert.match(html, /זה דף לדוגמה/);
    assert.match(html, /בשביל אבי אינסטלציה/);
    assert.ok(html.includes(`https://wa.me/972552735207?text=`) && html.includes(`(${SAMPLE.plumber.code})"`), 'the try goes to המוקדן with the sample code');
    const ac = await (await fetch(`${base}/p/demo?trade=ac`)).text();
    assert.match(ac, /בשביל רועי מיזוג אוויר/);
    assert.match(ac, /המזגן בסלון מטפטף/);
    assert.match(ac, /<a href="\/p\/demo\?trade=ac" aria-current="page">טכנאי מזגנים<\/a>/);
    assert.match(await (await fetch(`${base}/p/demo?trade=nonsense`)).text(), /בשביל אבי אינסטלציה/);
  } finally {
    server.close();
  }
  assert.equal(db.get('SELECT count(*) AS n FROM leads').n, 0);
});

test("a try from the sample page: המוקדן plays the sample business, with no lead, and the owner is not told", async () => {
  const toran = fakeToran();
  const claude = fakeClaude([{ reply: 'תודה, הפרטים אצל דני חשמל והם יחזרו אליך כשיתפנו.', done: true, what: 'אין חשמל במטבח', place: 'ויצמן 8, גבעתיים', urgency: 'עד הערב' }]);
  const { app, db, graph } = testApp({ env: DENV, toranFetch: toran.f });
  app.claude = claude;
  const ME = '972541234567';
  const sent = () => graph.sent().filter((c) => c.url.endsWith(`/${ASSIST}/messages`) && c.body.to === ME).map((c) => c.body.text.body);
  assert.match(SAMPLE.electrician.code, /^[a-z0-9]{10}$/);
  await toAssist(app, ME, `אני רוצה לנסות (${SAMPLE.electrician.code})`, 's1');
  assert.match(sent()[0], /נגיד שהתקשרתם לדני חשמל/);
  assert.match(sent()[1], /שלום, כאן העוזר של דני חשמל/);
  const d = db.get('SELECT lead_id, sample FROM demos');
  assert.deepEqual({ ...d }, { lead_id: null, sample: 'electrician' });
  await toAssist(app, ME, 'אין חשמל במטבח, ויצמן 8 גבעתיים, אני בבית עד הערב', 's2');
  await settle(app);
  assert.match(sent().at(-2), /\*מה:\* אין חשמל במטבח/);
  assert.equal(toran.alerts.length, 0, 'a sample try tells no one');
});
