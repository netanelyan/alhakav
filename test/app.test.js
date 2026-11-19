import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { hashPassword } from '../server/auth.js';
import { setNow } from '../server/clock.js';
import { handler } from '../server/app.js';
import { ENV, hook, testApp } from './helpers.js';

const PASSWORD = 'correct horse battery';
let server;
let base;
let ctx;

before(async () => {
  setNow(Date.parse('2026-11-22T08:00:00Z'));
  ctx = testApp({ env: { ...ENV, ADMIN_PASSWORD_HASH: hashPassword(PASSWORD) } });
  server = createServer(handler(ctx.app));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  setNow(null);
  server.close();
});

/** A browser of our own: keeps its cookies, never follows a redirect, and sends forms as a form does. */
function browser() {
  const jar = new Map();
  const go = async (path, { method = 'GET', form, headers = {} } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      redirect: 'manual',
      headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), origin: base, ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...headers },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      const v = kv.slice(i + 1);
      if (/Max-Age=0/.test(c) || !v) jar.delete(kv.slice(0, i));
      else jar.set(kv.slice(0, i), v);
    }
    return { status: res.status, location: res.headers.get('location'), text: await res.text(), headers: res.headers };
  };
  const csrfOf = (html) => /name="csrf" value="([^"]+)"/.exec(html)?.[1];
  return { go, jar, csrfOf };
}

async function signedIn() {
  const b = browser();
  const page = await b.go('/admin/login');
  const r = await b.go('/admin/login', { method: 'POST', form: { csrf: b.csrfOf(page.text), password: PASSWORD } });
  assert.equal(r.location, '/admin/leads');
  return b;
}

test('the admin pages are behind the password', async () => {
  const b = browser();
  assert.equal((await b.go('/admin/leads')).location, '/admin/login');
  const page = await b.go('/admin/login');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  const wrong = await b.go('/admin/login', { method: 'POST', form: { csrf: b.csrfOf(page.text), password: 'not it at all' } });
  assert.equal(wrong.location, '/admin/login');
  assert.match((await b.go('/admin/login')).text, /הסיסמה לא נכונה/);
  const noToken = await b.go('/admin/login', { method: 'POST', form: { password: PASSWORD } });
  assert.ok(!b.jar.has('ak_session'), noToken.location);
  const good = await b.go('/admin/login', { method: 'POST', form: { csrf: b.csrfOf((await b.go('/admin/login')).text), password: PASSWORD } });
  assert.equal(good.location, '/admin/leads');
  const list = await b.go('/admin/leads');
  assert.equal(list.status, 200);
  assert.match(list.text, /<h1>לידים<\/h1>/);
});

test('a form needs its token and our origin', async () => {
  const b = await signedIn();
  const before = ctx.db.get('SELECT count(*) AS n FROM leads').n;
  await b.go('/admin/leads/add', { method: 'POST', form: { url: 'avi.example' } });
  const other = await b.go('/admin/leads/add', { method: 'POST', form: { csrf: b.csrfOf((await b.go('/admin/leads')).text), url: 'avi.example' }, headers: { origin: 'https://evil.example' } });
  assert.equal(other.status, 403);
  assert.equal(ctx.db.get('SELECT count(*) AS n FROM leads').n, before);
});

test('a site added by its address becomes a lead with its page, its message and its score', async () => {
  const b = await signedIn();
  const csrf = b.csrfOf((await b.go('/admin/leads')).text);
  const r = await b.go('/admin/leads/add', { method: 'POST', form: { csrf, url: 'avi-plumbing.example' } });
  assert.match(r.location, /^\/admin\/leads\/\d+$/);
  const page = await b.go(r.location);
  assert.match(page.text, /נוסף: אבי אינסטלציה, ציון 100/);
  assert.match(page.text, /ככה הם יקראו את ההודעה/);
  assert.match(page.text, /איך זה יעבוד אצל אבי אינסטלציה\?/);
  assert.match(page.text, /למה הציון 100/);
  const list = await b.go('/admin/leads');
  assert.match(list.text, /אבי אינסטלציה/);
  // Sent from the row, back to the list with the line it says.
  const id = r.location.split('/').pop();
  const sent = await b.go(`/admin/leads/${id}/send`, { method: 'POST', form: { csrf, stage: 'first', back: 'list' } });
  assert.equal(sent.location, `/admin/leads#lead-${id}`);
  assert.match((await b.go('/admin/leads')).text, /ההודעה נשלחה מהמספר של העסק/);
  const reached = await b.go('/admin/leads/reached');
  assert.match(reached.text, /<b>1<\/b> נשלחה/);
});

test("Meta's webhook: verified once, and refused unless signed", async () => {
  const ok = await fetch(`${base}/meta/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42`);
  assert.equal(await ok.text(), '42');
  assert.equal((await fetch(`${base}/meta/webhook?hub.mode=subscribe&hub.verify_token=no&hub.challenge=42`)).status, 403);
  const body = JSON.stringify(hook({ messages: [{ id: 'wamid.web', from: '972521230000', type: 'text', text: { body: 'היי' } }] }));
  assert.equal((await fetch(`${base}/meta/webhook`, { method: 'POST', body, headers: { 'content-type': 'application/json' } })).status, 401);
  const sig = `sha256=${createHmac('sha256', ENV.META_APP_SECRET).update(body).digest('hex')}`;
  const signed = await fetch(`${base}/meta/webhook`, { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig } });
  assert.equal(signed.status, 200);
  assert.ok(ctx.db.get('SELECT 1 FROM leads WHERE mobile = ?', '972521230000'));
});

test('health, and nothing outside the routes', async () => {
  assert.equal(await (await fetch(`${base}/api/health`)).text(), 'ok');
  assert.equal((await fetch(`${base}/etc/passwd`)).status, 404);
  assert.equal((await fetch(`${base}/admin/static/..%2fapp.js`, { redirect: 'manual' })).status, 404);
  assert.equal((await fetch(`${base}/admin/static/admin.css`)).headers.get('content-type'), 'text/css; charset=utf-8');
});
