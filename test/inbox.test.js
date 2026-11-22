import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { hashPassword } from '../server/auth.js';
import { handler } from '../server/app.js';
import { nowIso, setNow } from '../server/clock.js';
import { conversations, thread, unreadCount } from '../server/inbox.js';
import { onWebhook, sendPitch } from '../server/outreach.js';
import { ENV, addLead, fakeToran, hook, testApp } from './helpers.js';

const PASSWORD = 'correct horse battery';
const ASSIST = '456';
const CALLER = '972521112233';
let server;
let base;
let ctx;
let lead;

before(async () => {
  setNow(Date.parse('2026-11-22T08:00:00Z'));
  const env = { ...ENV, ADMIN_PASSWORD_HASH: hashPassword(PASSWORD), ASSIST_PHONE_ID: ASSIST, ASSIST_NUMBER: '972552735207', OF_INTERNAL_TOKEN: 't'.repeat(40), TORAN_URL: 'http://toran.test', TORAN_DEBOUNCE_MS: '0' };
  ctx = testApp({ env, toranFetch: fakeToran([{ reply: 'כן, אפשר להתחיל היום' }]).f });
  const { app, db } = ctx;
  lead = addLead(db);
  assert.ok((await sendPitch(app, lead, 'first')).ok);
  setNow(Date.parse('2026-11-22T08:10:00Z'));
  await onWebhook(app, hook({ messages: [{ id: 'wamid.in1', from: lead.mobile, type: 'text', text: { body: 'מעניין, איך מתחילים?' } }] }));
  // המוקדן's side: a caller of a customer, kept as service.js keeps it.
  const c = Number(db.run("INSERT INTO customers (name, business, phone, created_at, updated_at) VALUES ('דני', 'דני חשמל', '972529998877', ?, ?)", nowIso(), nowIso()).lastInsertRowid);
  const chat = Number(db.run("INSERT INTO chats (customer_id, caller, opened_at, updated_at) VALUES (?, ?, ?, ?)", c, CALLER, nowIso(), nowIso()).lastInsertRowid);
  db.run("INSERT INTO chat_messages (chat_id, customer_id, peer, dir, kind, body, at) VALUES (?, ?, ?, 'out', 'first', 'שלום, כאן העוזר של דני חשמל', ?)", chat, c, CALLER, nowIso());
  setNow(Date.parse('2026-11-22T08:20:00Z'));
  db.run("INSERT INTO chat_messages (chat_id, customer_id, peer, dir, kind, body, at) VALUES (?, ?, ?, 'in', 'in', 'אין חשמל בכל הבית', ?)", chat, c, CALLER, nowIso());
  server = createServer(handler(ctx.app));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  setNow(null);
  server.close();
});

async function signedIn() {
  const jar = new Map();
  const go = async (path, { method = 'GET', form } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
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
  };
  const csrfOf = (html) => /name="csrf" value="([^"]+)"/.exec(html)?.[1];
  const login = await go('/admin/login');
  await go('/admin/login', { method: 'POST', form: { csrf: csrfOf(login.text), password: PASSWORD } });
  return { go, csrfOf };
}

test('both numbers in one list, the newest on top, each unread until it is opened', () => {
  const rows = conversations(ctx.db, ctx.app.env);
  assert.deepEqual(rows.map((r) => [r.line, r.phone]), [['assist', CALLER], ['biz', lead.mobile]]);
  assert.equal(rows[0].note, 'התקשר לדני חשמל');
  assert.equal(rows[1].name, 'אבי אינסטלציה');
  assert.equal(rows[1].body, 'כן, אפשר להתחיל היום', "Toran's answer is the newest on the business number");
  assert.equal(unreadCount(ctx.db, ctx.app.env), 2);
  assert.deepEqual(conversations(ctx.db, ctx.app.env, { tab: 'assist' }).map((r) => r.phone), [CALLER]);
  assert.deepEqual(conversations(ctx.db, ctx.app.env, { q: 'חשמל בכל' }).map((r) => r.phone), [CALLER]);
  assert.deepEqual(conversations(ctx.db, ctx.app.env, { q: lead.mobile.slice(-7) }).map((r) => r.phone), [lead.mobile]);
  assert.deepEqual(thread(ctx.db, 'biz', lead.mobile).map((m) => m.kind), ['first', 'in', 'bot']);
});

test('the inbox pages: the list, a conversation that becomes read, and an answer inside the 24 hours', async () => {
  const b = await signedIn();
  const list = await b.go('/admin/inbox');
  assert.equal(list.status, 200);
  assert.match(list.text, /אבי אינסטלציה/);
  assert.match(list.text, /התקשר לדני חשמל/);
  assert.match(list.text, /class="unread"/);
  assert.equal(JSON.parse((await b.go('/admin/inbox/unread')).text).n, 2);

  const one = await b.go(`/admin/inbox/biz/${lead.mobile}`);
  assert.equal(one.status, 200);
  assert.match(one.text, /מעניין, איך מתחילים\?/);
  assert.match(one.text, /class="compose"/, 'they wrote in the last 24 hours: the answer box');
  assert.equal(JSON.parse((await b.go('/admin/inbox/unread')).text).n, 1, 'opened: read');

  const r = await b.go(`/admin/inbox/biz/${lead.mobile}/reply`, { method: 'POST', form: { csrf: b.csrfOf(one.text), text: 'אני מתקשר אליך עוד מעט' } });
  assert.equal(r.location, `/admin/inbox/biz/${lead.mobile}`);
  const sent = ctx.graph.sent().at(-1).body;
  assert.equal(sent.to, lead.mobile);
  assert.equal(sent.text.body, 'אני מתקשר אליך עוד מעט');
  assert.equal(ctx.db.get("SELECT kind FROM messages WHERE body = 'אני מתקשר אליך עוד מעט'").kind, 'reply');

  const caller = await b.go(`/admin/inbox/assist/${CALLER}`);
  assert.match(caller.text, /אין חשמל בכל הבית/);
  assert.doesNotMatch(caller.text, /class="compose"/, "המוקדן's conversations are read only");
  assert.equal((await b.go('/admin/inbox/biz/972500000000')).status, 404);
});
