import { timingSafeEqual } from 'node:crypto';
import { alertOwner } from './alerts.js';
import { HOUR, MINUTE, afterQuiet, israelDate, israelParts, now, nowIso, quiet } from './clock.js';
import { TRADE } from './copy.js';
import { pageUrl } from './demo.js';
import { siteKey } from './detect.js';
import { discover, lastRun } from './discover.js';
import { num } from './env.js';
import { getLead, saveName, skip } from './leads.js';
import { metaSettings, numberQuality, templateStatus } from './meta.js';
import { firstTemplate, nameParam, outreachSettings, sendPitch, sentToday, stopped } from './outreach.js';
import { isMobile } from './phones.js';
import { fromUrls } from './sources.js';
import { textOf } from './support.js';

// The scheduled task's door (docs/autopilot.md), the owner, 2026-11-21: "i want a claude scheduled task to send the
// messages for tradespeople". As openfrequency-toran's src/ops/autopilot.ts: a Claude Code routine on the owner's
// subscription, in Anthropic's cloud, runs on working days, finds tradespeople on the web, adds their sites here, looks
// at each candidate, and sends the first message to the ones that fit, or sets them aside. This door is its only way
// in: /autopilot/*, with AUTOPILOT_TOKEN (32 characters at least) as a bearer. It does lead work only: it reads the
// candidates and the day's numbers, reads a site, adds sites, sends a first message or sets a lead aside, and keeps a
// note for the owner. It never sends a reminder, and never touches a customer, a payment or a setting. AUTOPILOT=1
// turns its writes on; anything else, they are refused with `off`.
//
// The routine's network reaches toran.openfrequency.co.il only, so Caddy hands that host's /alhakav/autopilot/* here
// (deploy/Caddyfile.example). Every guardrail of outreach.js still holds (the day's cap, quiet hours, Shabbat, the
// number's rating, one first message a lead); over them, at most AUTOPILOT_BATCH (5) in a half day (the morning, before
// 13:00 Israel time, and the afternoon), and nothing until Meta approved the first message's template.

export const AUTOPILOT_BATCH = 5;
const MAX_ADD = 15;

export const autopilotOn = (env) => String(env.AUTOPILOT || '').trim() === '1';

/** The key, as a bearer; anything else is refused. */
function refusal(app, req) {
  const token = String(app.env.AUTOPILOT_TOKEN || '').trim();
  if (token.length < 32) return { status: 503, json: { error: 'not_configured' } };
  const got = Buffer.from(String(req.headers.authorization || ''));
  const want = Buffer.from(`Bearer ${token}`);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { status: 401, json: { error: 'bad_token' } };
  return null;
}

const halfOf = (t) => (israelParts(t).hour < 13 ? 'morning' : 'afternoon');

/** First messages that left the business number today, and in this half of the day. */
function sent(db, at = now()) {
  const rows = db.all("SELECT at FROM messages WHERE dir = 'out' AND kind = 'first' AND wa_id IS NOT NULL AND day = ?", israelDate(at));
  return { day: sentToday(db, at), half: rows.filter((r) => halfOf(Date.parse(r.at)) === halfOf(at)).length };
}

function limits(env) {
  return { day: outreachSettings(env).daily, batch: num(env.AUTOPILOT_BATCH, AUTOPILOT_BATCH) };
}

// Meta's review of the first message's template (outreach.js firstTemplate: in their trade's words once approved),
// read at most every ten minutes.
let review = { at: 0, name: '', value: null };
export const forgetReview = () => {
  review = { at: 0, name: '', value: null };
};
async function templateNow(app) {
  const name = (await firstTemplate(app)).name;
  if (review.value && review.name === name && now() - review.at < 10 * MINUTE) return review.value;
  let value;
  try {
    value = await templateStatus(metaSettings(app.env), app.graphFetch, name);
  } catch (e) {
    app.log(`[autopilot] could not read the template's review: ${e.message}`);
    return 'UNKNOWN';
  }
  review = { at: now(), name, value };
  return value;
}
const approved = (status) => status === 'APPROVED' || status === 'UNKNOWN';

/** A lead the task may write to: on a list, fit, a mobile, never written to, not asked to stop. */
const candidate = (db, x) => Boolean(x && x.stage === 'new' && x.qualified && isMobile(x.mobile) && !x.first_at && !stopped(db, x.mobile));

const CANDIDATES = "SELECT * FROM leads WHERE stage = 'new' AND qualified = 1 AND mobile IS NOT NULL AND first_at IS NULL AND NOT EXISTS (SELECT 1 FROM stops WHERE stops.phone = leads.mobile) ORDER BY score DESC, id";

const json = (v, d) => {
  try {
    return JSON.parse(v);
  } catch {
    return d;
  }
};

function addNote(db, id, line) {
  db.run("UPDATE leads SET notes = trim(notes || char(10) || ?), updated_at = ? WHERE id = ?", `${israelDate()} ${line}`.slice(0, 400), nowIso(), id);
}

async function state(app) {
  const { db, env } = app;
  const at = now();
  const l = limits(env);
  const s = sent(db, at);
  const m = metaSettings(env);
  let quality = null;
  if (m.ready) {
    try {
      quality = await numberQuality(m, app.graphFetch);
    } catch {
      quality = null;
    }
  }
  const since = nowIso(at - 24 * HOUR);
  const last = lastRun(db);
  return {
    on: autopilotOn(env),
    quiet: quiet(at),
    quietUntil: quiet(at) ? nowIso(afterQuiet(at)) : null,
    half: halfOf(at),
    limits: l,
    sent: s,
    room: Math.max(0, Math.min(l.batch - s.half, l.day - s.day)),
    template: { name: (await firstTemplate(app)).name, status: await templateNow(app) },
    quality,
    pool: { ready: db.all(CANDIDATES).filter((x) => isMobile(x.mobile)).length, belowBar: db.get("SELECT count(*) AS n FROM leads WHERE stage = 'new' AND qualified = 0").n },
    last24h: {
      sent: db.get('SELECT count(*) AS n FROM leads WHERE first_at > ?', since).n,
      delivered: db.get("SELECT count(*) AS n FROM leads WHERE first_at > ? AND out_state IN ('delivered', 'read', 'yes', 'replied')", since).n,
      read: db.get("SELECT count(*) AS n FROM leads WHERE first_at > ? AND out_state IN ('read', 'yes', 'replied')", since).n,
      notDelivered: db.get("SELECT count(*) AS n FROM leads WHERE first_at > ? AND out_state IN ('failed', 'undelivered')", since).n,
      openedPage: db.get('SELECT count(*) AS n FROM leads WHERE page_last_at > ?', since).n,
      tried: db.get('SELECT count(DISTINCT lead_id) AS n FROM demos WHERE started_at > ?', since).n,
      answered: db.get('SELECT count(*) AS n FROM leads WHERE last_in_at > ?', since).n,
      stopped: db.get('SELECT count(*) AS n FROM stops WHERE at > ?', since).n,
    },
    brave: Boolean(String(env.BRAVE_API_KEY || '').trim()),
    lastSearch: last ? { source: last.source, at: last.finished_at, stats: last.stats } : null,
  };
}

function candidates(app, limit) {
  return app.db
    .all(`${CANDIDATES} LIMIT ?`, Math.min(Math.max(num(limit, 30), 1), 100))
    .filter((x) => isMobile(x.mobile))
    .map((x) => ({
      id: x.id,
      name: x.name,
      nameInMessage: nameParam(x),
      trade: TRADE[x.trade] || x.trade,
      city: x.city,
      domain: x.domain,
      url: x.url,
      score: x.score,
      why: json(x.breakdown, []),
      about: x.about,
      whatsappOnSite: Boolean(x.whatsapp_on_site),
      notes: x.notes || '',
    }));
}

async function site(app, id) {
  const x = getLead(app.db, num(id, 0));
  if (!x) return { status: 404, json: { error: 'not_found' } };
  const url = x.url || (x.domain ? `https://${x.domain}/` : '');
  if (!url) return { status: 200, json: { id: x.id, home: { url: '', status: 0, title: '', text: '' } } };
  try {
    const r = await app.fetchSite(url);
    const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(r.text || '') || [])[1] || '';
    return { status: 200, json: { id: x.id, home: { url: r.url || url, status: r.status, title: textOf(title).slice(0, 200), text: textOf(r.text || '').slice(0, 8000) } } };
  } catch (e) {
    return { status: 200, json: { id: x.id, home: { url, status: 0, title: '', text: '', error: String(e.code || e.message).slice(0, 200) } } };
  }
}

async function add(app, body) {
  const urls = [...new Set((Array.isArray(body.urls) ? body.urls : [body.url]).map((u) => String(u || '').trim()).filter(Boolean))].slice(0, MAX_ADD);
  if (!urls.length) return { status: 400, json: { error: 'no_urls' } };
  const known = urls.filter((u) => {
    const k = siteKey(/^https?:\/\//i.test(u) ? u : `https://${u}`);
    return !k || app.db.get('SELECT 1 FROM seen WHERE domain = ?', k) || app.db.get('SELECT 1 FROM leads WHERE domain = ?', k);
  });
  const r = await discover(app, fromUrls(urls, 'autopilot'), { limit: MAX_ADD, source: 'autopilot', query: urls.join(' ').slice(0, 500) });
  return {
    status: 200,
    json: {
      stats: r.stats,
      known: known.length,
      results: r.results.map((x) => (x.error ? { site: x.key, error: x.error } : { site: x.key, id: x.id ?? null, name: x.name ?? null, score: x.score ?? null, fit: Boolean(x.qualified), reject: x.reject || null })),
    },
  };
}

async function sendFirst(app, body) {
  const { db, env } = app;
  if (!autopilotOn(env)) return { sent: false, why: 'off' };
  let x = getLead(db, num(body.id, 0));
  if (!x) return { sent: false, why: 'not_found' };
  if (!candidate(db, x)) return { sent: false, why: x.first_at ? 'already' : stopped(db, x.mobile) ? 'stopped' : 'not_candidate' };
  const t = await templateNow(app);
  if (!approved(t)) return { sent: false, why: 'template_pending', template: t };
  const l = limits(env);
  const s = sent(db);
  if (s.half >= l.batch) return { sent: false, why: 'batch_cap' };
  if (body.name && String(body.name).trim()) {
    saveName(db, x, body.name);
    x = getLead(db, x.id);
  }
  const r = await sendPitch(app, x, 'first');
  if (!r.ok) return { sent: false, why: r.why || 'failed', error: r.flash };
  addNote(db, x.id, `הטייס שלח את ההודעה הראשונה${body.reason ? `: ${String(body.reason).trim()}` : ''}`);
  const after = getLead(db, x.id);
  return { sent: true, page: pageUrl(env, after.page_code), nameInMessage: nameParam(after) };
}

function skipLead(app, body) {
  const { db, env } = app;
  if (!autopilotOn(env)) return { status: 403, json: { ok: false, why: 'off' } };
  const x = getLead(db, num(body.id, 0));
  if (!x) return { status: 404, json: { ok: false, why: 'not_found' } };
  if (x.stage !== 'new') return { status: 409, json: { ok: false, why: 'not_new' } };
  skip(db, x);
  addNote(db, x.id, `הטייס דילג${body.reason ? `: ${String(body.reason).trim()}` : ''}`);
  return { status: 200, json: { ok: true } };
}

function recent(app, hours) {
  const since = nowIso(now() - Math.min(Math.max(num(hours, 24), 1), 24 * 14) * HOUR);
  const leads = app.db.all('SELECT * FROM leads WHERE first_at > ? OR last_in_at > ? OR page_last_at > ? ORDER BY first_at DESC', since, since, since);
  return leads.map((x) => ({
    id: x.id,
    name: x.msg_name || x.name,
    trade: TRADE[x.trade] || x.trade,
    city: x.city,
    sentAt: x.first_at,
    state: x.out_state,
    pageViews: x.page_views,
    tried: app.db.get('SELECT count(*) AS n FROM demos WHERE lead_id = ?', x.id).n,
    answered: Boolean(x.replied_at || x.yes_at),
    lastAnswerAt: x.last_in_at,
    closed: x.stage === 'closed' ? x.closed_why : null,
  }));
}

async function note(app, body) {
  const text = String(body.text || '').trim().slice(0, 1500);
  if (!text) return { status: 400, json: { error: 'empty' } };
  const id = Number(app.db.run('INSERT INTO autopilot_notes (text, tell, at) VALUES (?, ?, ?)', text, body.tell ? 1 : 0, nowIso()).lastInsertRowid);
  if (body.tell) await alertOwner(app, `autopilot:${id}`, 'על הקו: מה היה היום', text, 1);
  return { status: 200, json: { ok: true, id } };
}

/** /autopilot/*: { status, json }. `raw` is a POST's body. */
export async function autopilot(app, req, raw, url, p) {
  const refused = refusal(app, req);
  if (refused) return refused;
  let body = {};
  if (req.method === 'POST') {
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return { status: 400, json: { error: 'bad_json' } };
    }
  }
  const route = `${req.method} ${p}`;
  try {
    if (route === 'GET /autopilot/state') return { status: 200, json: await state(app) };
    if (route === 'GET /autopilot/candidates') return { status: 200, json: candidates(app, url.searchParams.get('limit')) };
    if (route === 'GET /autopilot/site') return await site(app, url.searchParams.get('id'));
    if (route === 'GET /autopilot/recent') return { status: 200, json: recent(app, url.searchParams.get('hours')) };
    if (route === 'GET /autopilot/notes') return { status: 200, json: app.db.all('SELECT id, text, tell, at FROM autopilot_notes ORDER BY id DESC LIMIT 10') };
    if (route === 'POST /autopilot/note') return await note(app, body);
    if (!autopilotOn(app.env) && route.startsWith('POST ')) return { status: 403, json: { error: 'off' } };
    if (route === 'POST /autopilot/add') return await add(app, body);
    if (route === 'POST /autopilot/send') return { status: 200, json: await sendFirst(app, body) };
    if (route === 'POST /autopilot/skip') return skipLead(app, body);
  } catch (e) {
    app.log(`[autopilot] ${route}: ${e.stack || e}`);
    return { status: 500, json: { error: 'failed' } };
  }
  return { status: 404, json: { error: 'not_found' } };
}
