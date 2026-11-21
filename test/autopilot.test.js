import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { afterEach, beforeEach, test } from 'node:test';
import { handler } from '../server/app.js';
import { forgetReview } from '../server/autopilot.js';
import { setNow } from '../server/clock.js';
import { forgetQuality } from '../server/outreach.js';
import { ENV, addLead, fakeToran, testApp } from './helpers.js';

const SUNDAY = Date.parse('2026-11-22T08:00:00Z'); // 10:00 in Israel, the morning
const KEY = 'k'.repeat(40);
const AENV = { ...ENV, META_WABA_ID: 'waba1', AUTOPILOT_TOKEN: KEY, AUTOPILOT: '1', OF_INTERNAL_TOKEN: 't'.repeat(40), TORAN_URL: 'http://toran.test' };

beforeEach(() => {
  setNow(SUNDAY);
  forgetQuality();
  forgetReview();
});
afterEach(() => setNow(null));

async function door(app, fn) {
  const server = createServer(handler(app));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body, key = KEY) => {
    const r = await fetch(`${base}${p}`, { method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json() };
  };
  try {
    await fn(call);
  } finally {
    server.close();
  }
}

test('the door: refused without the key, and closed while it has none', async () => {
  const { app } = testApp({ env: AENV });
  await door(app, async (call) => {
    assert.equal((await call('GET', '/autopilot/state', null, 'x'.repeat(40))).status, 401);
    assert.equal((await call('GET', '/autopilot/state', null, '')).status, 401);
  });
  const none = testApp({ env: { ...AENV, AUTOPILOT_TOKEN: 'short' } });
  await door(none.app, async (call) => assert.deepEqual(await call('GET', '/autopilot/state'), { status: 503, json: { error: 'not_configured' } }));
});

test('nothing goes until Meta approved the first message; then it goes with their page, a few a half day', async () => {
  const toran = fakeToran();
  const { app, db, graph } = testApp({ env: { ...AENV, AUTOPILOT_BATCH: '1' }, toranFetch: toran.f });
  const lead = addLead(db);
  const other = addLead(db, 'plumber', { mobile: '972541110000', domain: 'other' });
  await door(app, async (call) => {
    const st = (await call('GET', '/autopilot/state')).json;
    assert.equal(st.on, true);
    assert.equal(st.quiet, false);
    assert.equal(st.half, 'morning');
    assert.deepEqual(st.template, { name: 'alhakav_page', status: 'MISSING' });
    assert.equal(st.pool.ready, 2);
    assert.equal(st.room, 1);
    const list = (await call('GET', '/autopilot/candidates')).json;
    assert.equal(list.length, 2);
    assert.equal(list[0].nameInMessage, 'אצל אבי אינסטלציה');
    assert.equal(list[0].trade, 'אינסטלטור');
    assert.ok(!('mobile' in list[0]), 'no phone numbers leave the door');
    assert.deepEqual((await call('POST', '/autopilot/send', { id: lead.id })).json, { sent: false, why: 'template_pending', template: 'MISSING' });
    assert.equal(graph.sent().length, 0);

    graph.templates.alhakav_page = 'APPROVED';
    forgetReview();
    const r = (await call('POST', '/autopilot/send', { id: lead.id, name: 'אבי', reason: 'אינסטלטור עצמאי באשדוד' })).json;
    assert.equal(r.sent, true);
    assert.equal(r.nameInMessage, 'אצל אבי');
    const x = db.get('SELECT * FROM leads WHERE id = ?', lead.id);
    assert.equal(r.page, `https://alhakav.example/p/${x.page_code}`);
    const t = graph.sent()[0].body.template;
    assert.equal(t.name, 'alhakav_page');
    assert.deepEqual(t.components[1].parameters, [{ type: 'text', text: x.page_code }]);
    assert.match(x.notes, /הטייס שלח את ההודעה הראשונה: אינסטלטור עצמאי באשדוד/);
    assert.equal(x.stage, 'waiting');
    assert.equal((await call('POST', '/autopilot/send', { id: lead.id })).json.why, 'already');
    assert.equal((await call('POST', '/autopilot/send', { id: other.id })).json.why, 'batch_cap');
    assert.equal((await call('GET', '/autopilot/state')).json.room, 0);
    const recent = (await call('GET', '/autopilot/recent?hours=24')).json;
    assert.equal(recent.length, 1);
    assert.equal(recent[0].name, 'אבי');
  });
});

test('set aside, sites added by address, and the guardrails: off, quiet', async () => {
  const toran = fakeToran();
  const { app, db, graph } = testApp({ env: AENV, toranFetch: toran.f });
  graph.templates.alhakav_page = 'APPROVED';
  const lead = addLead(db, 'plumber', { mobile: '972541110001', domain: 'first' });
  await door(app, async (call) => {
    const added = (await call('POST', '/autopilot/add', { urls: ['new-plumber.example', 'https://new-plumber.example/'] })).json;
    assert.equal(added.stats.added, 1);
    assert.equal(added.results[0].fit, true);
    const id = added.results[0].id;
    assert.deepEqual((await call('POST', '/autopilot/skip', { id, reason: 'רשת ארצית' })).json, { ok: true });
    const skipped = db.get('SELECT stage, closed_why, notes FROM leads WHERE id = ?', id);
    assert.equal(skipped.closed_why, 'skipped');
    assert.match(skipped.notes, /הטייס דילג: רשת ארצית/);
    assert.equal((await call('POST', '/autopilot/send', { id })).json.why, 'not_candidate');
    const site = (await call('GET', `/autopilot/site?id=${lead.id}`)).json;
    assert.equal(site.home.status, 200);
    assert.ok(site.home.text.length > 50);
    // Saturday: quiet.
    setNow(Date.parse('2026-11-21T09:00:00Z'));
    assert.equal((await call('POST', '/autopilot/send', { id: lead.id })).json.why, 'quiet');
    assert.equal((await call('GET', '/autopilot/state')).json.quiet, true);
    // A note for the owner, on their WhatsApp when asked.
    assert.equal((await call('POST', '/autopilot/note', { text: 'היום נשלחו 4 הודעות.', tell: true })).json.ok, true);
    assert.equal(toran.alerts.at(-1).body, 'היום נשלחו 4 הודעות.');
    assert.equal((await call('GET', '/autopilot/notes')).json[0].text, 'היום נשלחו 4 הודעות.');
  });
  const off = testApp({ env: { ...AENV, AUTOPILOT: '' } });
  const l2 = addLead(off.db);
  await door(off.app, async (call) => {
    assert.equal((await call('POST', '/autopilot/send', { id: l2.id })).status, 403);
    assert.equal((await call('GET', '/autopilot/state')).json.on, false);
  });
});
