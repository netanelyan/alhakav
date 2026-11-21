import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeApp } from '../server/app.js';
import { Db } from '../server/db.js';
import { analyze, readPage } from '../server/detect.js';
import { saveLead } from '../server/discover.js';
import { scoreLead } from '../server/score.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
export const fixture = (name) => readFileSync(path.join(DIR, `${name}.html`), 'utf8');

/** A site read from a fixture, as detect() would, under another address. */
export const detected = (name, url = `https://${name}.example/`) => analyze([readPage(fixture(name), url)], url);

/**
 * Meta's Graph API, faked: each message sent answers wamid.N; `quality` is the number's rating; `fail` makes the next
 * send answer that error. calls holds what was sent.
 */
export function fakeGraph() {
  const g = { calls: [], quality: 'GREEN', fail: null, n: 0, media: {} };
  g.f = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    g.calls.push({ url: String(url), method: init.method, body, auth: init.headers?.authorization });
    if (String(url).includes('fields=quality_rating')) return Response.json({ quality_rating: g.quality, id: '123' });
    // A file someone sent: its address first, then its bytes from there (g.media: id -> { mime, bytes }).
    const media = /\/v23\.0\/([\w.-]+)$/.exec(String(url));
    if (media && g.media[media[1]]) return Response.json({ url: `https://graph.test/files/${media[1]}`, mime_type: g.media[media[1]].mime, file_size: g.media[media[1]].bytes.length, id: media[1] });
    const file = /^https:\/\/graph\.test\/files\/([\w.-]+)$/.exec(String(url));
    if (file) return g.media[file[1]] ? new Response(g.media[file[1]].bytes) : new Response('gone', { status: 404 });
    if (g.fail) {
      const error = g.fail;
      g.fail = null;
      return Response.json({ error }, { status: 400 });
    }
    g.n++;
    return Response.json({ messaging_product: 'whatsapp', messages: [{ id: `wamid.${g.n}` }] });
  };
  g.sent = () => g.calls.filter((c) => c.method === 'POST');
  return g;
}

export const ENV = {
  META_TOKEN: 'token',
  META_PHONE_ID: '123',
  META_APP_SECRET: 'app-secret',
  META_VERIFY_TOKEN: 'verify-me',
  META_GRAPH: 'https://graph.test/v23.0',
  SENDER_LINE: 'על הקו, ישראל ישראלי, רחוב הדוגמה 1, אשדוד. alhakav.example',
  SITE_URL: 'https://alhakav.example',
  OUTREACH_DAILY: '2',
  SESSION_SECRET: 'x'.repeat(40),
};

export function testApp({ env = ENV, graph = fakeGraph(), fetchSite, toranFetch } = {}) {
  const db = new Db(':memory:');
  const logs = [];
  const app = makeApp({ db, env, graphFetch: graph.f, apiFetch: graph.f, toranFetch, fetchSite: fetchSite || (async (url) => ({ url, status: 200, text: fixture('plumber') })), log: (m) => logs.push(m), searchPause: 0 });
  return { app, db, graph, logs };
}

/**
 * openfrequency-toran on this machine, faked: `answers` are its answers to /internal/company/answer in turn (an Error
 * throws, a number answers that status); calls holds what it was asked, alerts what /internal/ops/alert was given.
 */
export function fakeToran(answers = []) {
  const t = { calls: [], alerts: [], answers: [...answers] };
  t.f = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    if (String(url).endsWith('/internal/ops/alert')) {
      t.alerts.push({ ...body, auth: init.headers?.authorization });
      return Response.json({ ok: true, due: true });
    }
    t.calls.push({ url: String(url), body, auth: init.headers?.authorization });
    const a = t.answers.shift() ?? { reply: null, handoff: null };
    if (a instanceof Error) throw a;
    if (typeof a === 'number') return Response.json({ error: 'x' }, { status: a });
    return Response.json({ conversationId: 1, handoff: null, ...a });
  };
  return t;
}

export const TORAN_ENV = { ...ENV, OF_INTERNAL_TOKEN: 't'.repeat(40), TORAN_URL: 'http://toran.test', TORAN_DEBOUNCE_MS: '0', PAYMENT_DETAILS: 'בנק הפועלים (12), סניף 345, חשבון 678901, על שם ישראל ישראלי' };

/** A lead from a fixture, saved as discovery saves one, with another mobile when asked. */
export function addLead(db, name = 'plumber', { mobile, domain } = {}) {
  const d = detected(name, `https://${domain || name}.example/`);
  if (mobile) d.mobile = mobile;
  const s = scoreLead(d, Date.parse('2026-11-19T10:00:00Z'));
  const { id } = saveLead(db, d, s, { source: 'admin', detail: {} });
  return db.get('SELECT * FROM leads WHERE id = ?', id);
}

/** A webhook body as Meta sends it. */
export function hook({ messages = [], statuses = [], name = 'אבי', phoneId = '123' } = {}) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: 'waba', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: phoneId }, contacts: messages.map((m) => ({ wa_id: m.from, profile: { name } })), messages, statuses } }] }],
  };
}
