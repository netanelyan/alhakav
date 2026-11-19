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
  const g = { calls: [], quality: 'GREEN', fail: null, n: 0 };
  g.f = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    g.calls.push({ url: String(url), method: init.method, body });
    if (String(url).includes('fields=quality_rating')) return Response.json({ quality_rating: g.quality, id: '123' });
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

export function testApp({ env = ENV, graph = fakeGraph(), fetchSite } = {}) {
  const db = new Db(':memory:');
  const logs = [];
  const app = makeApp({ db, env, graphFetch: graph.f, apiFetch: graph.f, fetchSite: fetchSite || (async (url) => ({ url, status: 200, text: fixture('plumber') })), log: (m) => logs.push(m), searchPause: 0 });
  return { app, db, graph, logs };
}

/** A lead from a fixture, saved as discovery saves one, with another mobile when asked. */
export function addLead(db, name = 'plumber', { mobile, domain } = {}) {
  const d = detected(name, `https://${domain || name}.example/`);
  if (mobile) d.mobile = mobile;
  const s = scoreLead(d, Date.parse('2026-11-19T10:00:00Z'));
  const { id } = saveLead(db, d, s, { source: 'admin', detail: {} });
  return db.get('SELECT * FROM leads WHERE id = ?', id);
}

/** A webhook body as Meta sends it. */
export function hook({ messages = [], statuses = [], name = 'אבי' } = {}) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: 'waba', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: '123' }, contacts: messages.map((m) => ({ wa_id: m.from, profile: { name } })), messages, statuses } }] }],
  };
}
