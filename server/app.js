import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPassword, clientIp, cookies, csrfFor, csrfOk, endSession, hashPassword, isHttps, limiter, looksLikeToken, newToken, sessionOf, sessionSecret, startSession } from './auth.js';
import { now, whenHe } from './clock.js';
import { T } from './copy.js';
import { siteKey } from './detect.js';
import { discover, lastRun, startDiscovery } from './discover.js';
import { makeFetcher } from './fetcher.js';
import { REACHED_TABS, countsNew, countsReached, funnel, getLead, lastIn, later, listNew, listReached, lose, markCustomer, markReplied, messagesOf, removeLead, reopen, saveName, saveNotes, skip, stopLead } from './leads.js';
import { metaSettings, signatureOk } from './meta.js';
import { markByHand, onWebhook, reply, sendPitch, stopped } from './outreach.js';
import { leadPage, leadsPage, loginPage, notFoundPage, reachedPage } from './pages.js';
import { fromUrls } from './sources.js';
import { makeClaude } from './claude.js';
import { addSkip, createCustomer, customerFromLead, endAtMonthEnd, getCustomer, listCustomers, recentCalls, recentChats, removeCustomer, removeSkip, setStatus, skipsOf, unend, updateBilling, updateCustomer } from './customers.js';
import { customerPage, customersPage } from './customerPages.js';
import { dateHe } from './billing.js';
import { PAY, TC } from './copy.js';
import { local } from './phones.js';
import { morningClient, morningConfig } from './morning.js';
import { PayError, decideReceipt, manualPayment, noticesOf, receiptById, receiptFile, receiptsOf, receiptsWaiting, retryInvoice, sendPayment } from './pay.js';
import { receiptPage } from './payPages.js';
import { onCall, serviceState, track } from './service.js';
import { readEvent, signatureOk as telnyxSigned, telnyxSettings } from './telnyx.js';
import { toranState } from './toran.js';
import { leadByCode, pageHtml, pageViewed } from './demo.js';
import { autopilot } from './autopilot.js';
import { giveNumber } from './numbers.js';
import { LINES, conversations, inboxPage, leadOf, markSeen, thread, threadPage, unreadCount } from './inbox.js';

// The one HTTP server, behind Caddy on 127.0.0.1:
//
//   /admin/...      the admin's pages and forms (signed in, every POST with its CSRF token and from this origin),
//                   the transfer receipts among them (/admin/receipts/<id>, docs/payments.md), and the inbox of both
//                   numbers' WhatsApp messages (/admin/inbox, inbox.js)
//   /meta/webhook   Meta's webhook: GET to verify it once (META_VERIFY_TOKEN), POST for every message and status,
//                   signed with META_APP_SECRET (the outreach number)
//   /telnyx/webhook Telnyx's webhook for the customers' own numbers: the calls forwarded to them, signed
//                   with Ed25519 (TELNYX_PUBLIC_KEY), answered at once and handled after (service.js)
//   /api/health     "ok" while the process runs
//   /autopilot/*    the scheduled task's door (autopilot.js, docs/autopilot.md), JSON with AUTOPILOT_TOKEN
//   /p/<code>       a lead's own page (demo.js)
//   /               the landing page, for running it on a laptop; on the server Caddy serves it as a file

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATIC_DIR = path.join(ROOT, 'server', 'static');
const STATIC = { 'admin.css': 'text/css; charset=utf-8', 'admin.js': 'text/javascript; charset=utf-8' };
const HTML = 'text/html; charset=utf-8';
const SVG = 'image/svg+xml';
const PNG = 'image/png';
// The public site: the landing page, the legal pages and the brand files they show, by name only (the repo's other
// files are never served).
const PUBLIC = {
  '/': ['index.html', HTML],
  '/index.html': ['index.html', HTML],
  '/terms.html': ['terms.html', HTML],
  '/terms': ['terms.html', HTML],
  '/privacy.html': ['privacy.html', HTML],
  '/privacy': ['privacy.html', HTML],
  '/accessibility.html': ['accessibility.html', HTML],
  '/accessibility': ['accessibility.html', HTML],
  '/legal.css': ['legal.css', 'text/css; charset=utf-8'],
  '/svg/al-hakav-logo.svg': ['svg/al-hakav-logo.svg', SVG],
  '/svg/al-hakav-logo-on-dark.svg': ['svg/al-hakav-logo-on-dark.svg', SVG],
  '/svg/al-hakav-icon.svg': ['svg/al-hakav-icon.svg', SVG],
  '/svg/al-hakav-mokdan-avatar.svg': ['svg/al-hakav-mokdan-avatar.svg', SVG],
  '/svg/al-hakav-favicon.svg': ['svg/al-hakav-favicon.svg', SVG],
  '/png/favicon-32.png': ['png/favicon-32.png', PNG],
  '/png/apple-touch-icon.png': ['png/apple-touch-icon.png', PNG],
  '/favicon.ico': ['png/favicon-32.png', PNG],
};

const HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'x-frame-options': 'DENY',
  // The admin pages load the site's own font, Heebo, from Google Fonts, as the landing page does.
  'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

/** Everything the server works with, so the tests can hand it a database, fake sites and a fake Meta. */
export function makeApp({ db, env = {}, fetchSite, apiFetch = fetch, graphFetch, telnyxFetch, toranFetch, morningFetch, claude, log = (m) => console.log(m), searchPause } = {}) {
  return {
    db,
    env,
    fetchSite: fetchSite || makeFetcher(),
    apiFetch,
    graphFetch: graphFetch || apiFetch,
    telnyxFetch: telnyxFetch || apiFetch,
    toranFetch: toranFetch || apiFetch,
    toran: toranState(),
    claude: claude === undefined ? makeClaude(env) : claude,
    morning: morningClient(morningConfig(env), morningFetch || apiFetch),
    log,
    secret: sessionSecret(env),
    logins: limiter(),
    discovery: { running: null, done: null },
    service: serviceState(),
    searchPause,
  };
}

// ---- responses

function cookie(res, req, name, value, { maxAge, path: p = '/' } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${p}`, 'HttpOnly', 'SameSite=Lax'];
  if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);
  if (isHttps(req)) parts.push('Secure');
  res.cookies = [...(res.cookies || []), parts.join('; ')];
}

function send(res, status, type, body, headers = {}) {
  res.writeHead(status, { ...HEADERS, 'content-type': type, 'cache-control': 'no-store', ...(res.cookies ? { 'set-cookie': res.cookies } : {}), ...headers });
  res.end(body);
}

const redirect = (res, to) => send(res, 303, 'text/plain; charset=utf-8', '', { location: to });

/** Back to a page with one line at its top. */
function see(res, req, to, flash, bad = false) {
  if (flash) cookie(res, req, 'ak_flash', `${bad ? '!' : ''}${flash}`, { path: '/admin', maxAge: 60 });
  redirect(res, to);
}

function takeFlash(res, req, c) {
  const f = c.ak_flash;
  if (!f) return { flash: '', bad: false };
  cookie(res, req, 'ak_flash', '', { path: '/admin', maxAge: 0 });
  return f.startsWith('!') ? { flash: f.slice(1), bad: true } : { flash: f, bad: false };
}

async function readBody(req, max) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw Object.assign(new Error('too large'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const readForm = async (req) => Object.fromEntries(new URLSearchParams(await readBody(req, 64 * 1024)));

/** A form from this site: a browser always sends Origin on a POST, and it must be ours. */
function sameOrigin(req) {
  const o = req.headers.origin;
  if (!o) return true;
  try {
    return new URL(o).host === req.headers.host;
  } catch {
    return false;
  }
}

// ---- the routes

export function handler(app) {
  return async (req, res) => {
    try {
      await route(app, req, res);
    } catch (e) {
      if (e.status === 413) return send(res, 413, 'text/plain; charset=utf-8', 'too large');
      app.log(`[http] ${req.method} ${req.url}: ${e.stack || e}`);
      if (!res.headersSent) send(res, 500, 'text/plain; charset=utf-8', T.error);
    }
  };
}

async function route(app, req, res) {
  const url = new URL(req.url, 'http://local');
  const p = url.pathname.replace(/\/+$/, '') || '/';
  if (p === '/api/health') return send(res, 200, 'text/plain; charset=utf-8', 'ok');
  if (p === '/meta/webhook') return webhook(app, req, res, url);
  if (p === '/telnyx/webhook') return telnyxWebhook(app, req, res);
  if (p.startsWith('/autopilot/')) {
    const raw = req.method === 'POST' ? await readBody(req, 64 * 1024) : '';
    const out = await autopilot(app, req, raw, url, p);
    return send(res, out.status, 'application/json; charset=utf-8', JSON.stringify(out.json));
  }
  // A lead's own page (demo.js): its code, or not found; never indexed, never cached, each view counted.
  const page = /^\/p\/([a-z0-9]{10})$/.exec(p);
  if (page && req.method === 'GET') {
    const lead = leadByCode(app.db, page[1]);
    if (!lead) return send(res, 404, 'text/plain; charset=utf-8', 'not found');
    await pageViewed(app, lead);
    return send(res, 200, HTML, pageHtml(app.env, lead), { 'content-security-policy': "frame-ancestors 'none'", 'x-robots-tag': 'noindex, nofollow' });
  }
  if (PUBLIC[p] && req.method === 'GET') {
    const [file, type] = PUBLIC[p];
    return send(res, 200, type, readFileSync(path.join(ROOT, file)), { 'content-security-policy': "frame-ancestors 'none'", 'cache-control': 'public, max-age=300' });
  }
  if (p.startsWith('/admin/static/')) {
    const name = p.slice('/admin/static/'.length);
    if (!STATIC[name]) return send(res, 404, 'text/plain; charset=utf-8', 'not found');
    return send(res, 200, STATIC[name], readFileSync(path.join(STATIC_DIR, name)), { 'cache-control': 'no-cache' });
  }
  if (p !== '/admin' && !p.startsWith('/admin/')) return send(res, 404, 'text/plain; charset=utf-8', 'not found');

  const c = cookies(req);
  if (p === '/admin/login') return login(app, req, res, c);
  const token = c.ak_session;
  if (!sessionOf(app.db, token)) {
    if (req.method === 'GET') return redirect(res, '/admin/login');
    return send(res, 403, 'text/plain; charset=utf-8', 'sign in first');
  }
  const csrf = csrfFor(token, app.secret);

  if (req.method === 'POST') {
    if (!sameOrigin(req)) return send(res, 403, 'text/plain; charset=utf-8', 'another origin');
    const form = await readForm(req);
    if (!csrfOk(form.csrf, token, app.secret)) return see(res, req, p.replace(/\/[a-z-]+$/, '') || '/admin/leads', T.csrf, true);
    return post(app, req, res, p, form, token);
  }
  if (req.method !== 'GET') return send(res, 405, 'text/plain; charset=utf-8', 'method not allowed');

  const at = now();
  if (p === '/admin') return redirect(res, '/admin/leads');
  if (p === '/admin/leads') {
    const tab = ['fit', 'below', 'all'].includes(url.searchParams.get('tab')) ? url.searchParams.get('tab') : 'fit';
    const q = String(url.searchParams.get('q') || '').slice(0, 100);
    const { flash, bad } = takeFlash(res, req, c);
    return send(res, 200, HTML, leadsPage({ csrf, flash, bad, env: app.env, tab, q, rows: listNew(app.db, { tab, q }), counts: countsNew(app.db, q), reachedAll: countsReached(app.db).all, discovery: app.discovery, run: lastRun(app.db), at }));
  }
  if (p === '/admin/leads/reached') {
    const tab = REACHED_TABS.includes(url.searchParams.get('tab')) ? url.searchParams.get('tab') : '';
    const q = String(url.searchParams.get('q') || '').slice(0, 100);
    const rows = listReached(app.db, { tab, q, at });
    const lastIns = new Map(rows.map((x) => [x.id, lastIn(app.db, x.id)]));
    const { flash, bad } = takeFlash(res, req, c);
    return send(res, 200, HTML, reachedPage({ csrf, flash, bad, env: app.env, tab, q, rows, counts: countsReached(app.db, q), funnel: funnel(app.db), lastIns, at }));
  }
  if (p === '/admin/inbox') {
    const tab = ['unread', ...LINES].includes(url.searchParams.get('tab')) ? url.searchParams.get('tab') : '';
    const q = String(url.searchParams.get('q') || '').slice(0, 100);
    const { flash, bad } = takeFlash(res, req, c);
    return send(res, 200, HTML, inboxPage({ csrf, flash, bad, rows: conversations(app.db, app.env, { tab, q }), tab, q, counts: { unread: unreadCount(app.db, app.env) }, at }));
  }
  if (p === '/admin/inbox/unread') return send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ n: unreadCount(app.db, app.env) }));
  const conv = /^\/admin\/inbox\/(biz|assist)\/(\d{8,15})$/.exec(p);
  if (conv) {
    const [, line, phone] = conv;
    const messages = thread(app.db, line, phone);
    const rows = conversations(app.db, app.env);
    const who = rows.find((r) => r.line === line && r.phone === phone);
    if (!messages.length || !who) return send(res, 404, HTML, notFoundPage(csrf));
    markSeen(app.db, line, phone);
    const { flash, bad } = takeFlash(res, req, c);
    return send(res, 200, HTML, threadPage({ csrf, flash, bad, line, phone, who, messages, lead: line === 'biz' ? leadOf(app.db, phone) : null, metaReady: metaSettings(app.env).ready, rows: rows.map((r) => (r === who ? { ...r, unread: false } : r)), at }));
  }
  if (p === '/admin/customers') {
    const { flash, bad } = takeFlash(res, req, c);
    return send(res, 200, HTML, customersPage(app, { csrf, flash, bad, rows: listCustomers(app.db, at), waiting: receiptsWaiting(app.db), at }));
  }
  const cust = /^\/admin\/customers\/(\d+)$/.exec(p);
  if (cust) {
    const cu = getCustomer(app.db, Number(cust[1]));
    if (!cu) return send(res, 404, HTML, notFoundPage(csrf));
    const { flash, bad } = takeFlash(res, req, c);
    return send(res, 200, HTML, customerPage(app, { csrf, flash, bad, c: cu, skips: skipsOf(app.db, cu.id), chats: recentChats(app.db, cu.id), calls: recentCalls(app.db, cu.id), receipts: receiptsOf(app.db, cu.id), notices: noticesOf(app.db, cu.id), at }));
  }
  const rcpt = /^\/admin\/receipts\/(\d+)(\/file)?$/.exec(p);
  if (rcpt) {
    if (rcpt[2]) {
      const f = receiptFile(app.db, Number(rcpt[1]));
      if (!f) return send(res, 404, 'text/plain; charset=utf-8', 'not found');
      return send(res, 200, f.type, f.file, { 'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'", 'content-disposition': 'inline' });
    }
    const r = receiptById(app.db, Number(rcpt[1]));
    if (!r) return send(res, 404, HTML, notFoundPage(csrf));
    const { flash, bad } = takeFlash(res, req, c);
    return send(res, 200, HTML, receiptPage({ csrf, flash, bad, r, c: r.customer_id ? getCustomer(app.db, r.customer_id) : null }));
  }
  const one = /^\/admin\/leads\/(\d+)$/.exec(p);
  if (one) {
    const lead = getLead(app.db, Number(one[1]));
    if (!lead) return send(res, 404, HTML, notFoundPage(csrf));
    const { flash, bad } = takeFlash(res, req, c);
    return send(res, 200, HTML, leadPage(app, { csrf, flash, bad, lead, messages: messagesOf(app.db, lead.id), isStopped: stopped(app.db, lead.mobile), at }));
  }
  return send(res, 404, HTML, notFoundPage(csrf));
}

async function login(app, req, res, c) {
  const hash = String(app.env.ADMIN_PASSWORD_HASH || '').trim();
  if (req.method === 'GET') {
    if (sessionOf(app.db, c.ak_session)) return redirect(res, '/admin/leads');
    let pre = c.ak_pre;
    if (!looksLikeToken(pre)) {
      pre = newToken();
      cookie(res, req, 'ak_pre', pre, { path: '/admin', maxAge: 3600 });
    }
    const { flash } = takeFlash(res, req, c);
    return send(res, 200, HTML, loginPage({ csrf: csrfFor(pre, app.secret), error: flash, notSet: !hash }));
  }
  if (req.method !== 'POST') return send(res, 405, 'text/plain; charset=utf-8', 'method not allowed');
  if (!sameOrigin(req)) return send(res, 403, 'text/plain; charset=utf-8', 'another origin');
  const form = await readForm(req);
  if (!csrfOk(form.csrf, c.ak_pre, app.secret)) return see(res, req, '/admin/login', T.csrf, true);
  const ip = clientIp(req);
  if (!app.logins.allow(ip)) return see(res, req, '/admin/login', T.login.tooMany, true);
  // With no hash set, a password is still checked against something, so the answer takes as long either way.
  const ok = checkPassword(String(form.password || ''), hash || DUMMY) && Boolean(hash);
  if (!ok) {
    app.log(`[admin] a wrong password from ${ip}`);
    return see(res, req, '/admin/login', T.login.wrong, true);
  }
  app.logins.clear(ip);
  cookie(res, req, 'ak_session', startSession(app.db, ip), { maxAge: 30 * 24 * 3600 });
  cookie(res, req, 'ak_pre', '', { path: '/admin', maxAge: 0 });
  app.log(`[admin] signed in from ${ip}`);
  return redirect(res, '/admin/leads');
}

const DUMMY = hashPassword('not a password', Buffer.alloc(16));

/** Where a lead's form goes back to: its row on the list it came from, or its own page at the card it was on. */
function backTo(lead, form, anchor) {
  if (form.back === 'list') return `/admin/leads#lead-${lead.id}`;
  if (form.back === 'reached') return `/admin/leads/reached#lead-${lead.id}`;
  return `/admin/leads/${lead.id}${anchor ? `#${anchor}` : ''}`;
}

async function post(app, req, res, p, form, token) {
  if (p === '/admin/logout') {
    endSession(app.db, token);
    cookie(res, req, 'ak_session', '', { maxAge: 0 });
    return redirect(res, '/admin/login');
  }
  if (p === '/admin/leads/add') {
    const raw = String(form.url || '').trim();
    const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    if (!raw || !siteKey(url)) return see(res, req, '/admin/leads', T.leads.addBad, true);
    const r = await discover(app, fromUrls([url]), { limit: 1, concurrency: 1, source: 'admin', query: url, force: true }).catch((e) => ({ results: [{ error: e.message }] }));
    const got = r.results.find((x) => x.id);
    if (!got) return see(res, req, '/admin/leads', T.leads.addFailed(r.results[0]?.error || r.results[0]?.reject || '?'), true);
    return see(res, req, `/admin/leads/${got.id}`, got.qualified ? T.leads.added(got.name, got.score) : T.leads.addedBelow(got.name, got.reject), !got.qualified);
  }
  if (p === '/admin/discover') {
    const trade = String(form.trade || '');
    const city = String(form.city || '').replace(/[^֐-׿\s'"-]/g, '').trim().slice(0, 40);
    const started = startDiscovery(app, { trade, city, queries: trade && city ? 2 : 3 });
    return see(res, req, '/admin/leads', started ? T.leads.started : T.leads.busy, !started);
  }
  if (p === '/admin/customers/new') {
    const r = createCustomer(app.db, form);
    return see(res, req, r.ok ? `/admin/customers/${r.id}` : '/admin/customers', r.flash, !r.ok);
  }
  const ir = /^\/admin\/inbox\/biz\/(\d{8,15})\/reply$/.exec(p);
  if (ir) {
    const back = `/admin/inbox/biz/${ir[1]}`;
    const lead = leadOf(app.db, ir[1]);
    if (!lead) return see(res, req, back, T.inbox.notYet, true);
    const r = await reply(app, lead, form.text);
    return see(res, req, back, r.ok ? T.inbox.sent : r.flash, !r.ok);
  }
  const cm = /^\/admin\/customers\/(\d+)\/([a-z-]+)$/.exec(p);
  if (cm) return customerAction(app, req, res, Number(cm[1]), cm[2], form, token);
  const rm = /^\/admin\/receipts\/(\d+)\/(paid|not-paid|invoice)$/.exec(p);
  if (rm) return receiptAction(app, req, res, Number(rm[1]), rm[2], form);
  const m = /^\/admin\/leads\/(\d+)\/([a-z-]+)$/.exec(p);
  const lead = m && getLead(app.db, Number(m[1]));
  if (!lead) return send(res, 404, HTML, notFoundPage(csrfFor(token, app.secret)));
  const stage = form.stage === 'reminder' ? 'reminder' : 'first';
  const done = (flash, bad = false, anchor = '') => see(res, req, backTo(lead, form, anchor), flash, bad);
  switch (m[2]) {
    case 'send': {
      const r = await sendPitch(app, lead, stage);
      return done(r.flash, !r.ok, 'send');
    }
    case 'mark-sent': {
      const r = markByHand(app, lead, stage);
      return done(r.flash, !r.ok, 'send');
    }
    case 'reply': {
      const r = await reply(app, lead, form.text);
      return done(r.flash, !r.ok, 'chat');
    }
    case 'name':
      return done(saveName(app.db, lead, form.name), false, 'send');
    case 'replied':
      return done(markReplied(app.db, lead), false, 'stands');
    case 'customer': {
      const flash = markCustomer(app.db, lead);
      const id = customerFromLead(app.db, lead);
      return id ? see(res, req, `/admin/customers/${id}`, flash) : done(flash, false, 'stands');
    }
    case 'later':
      return done(later(app.db, lead, form.days, (t) => whenHe(t)), false, 'stands');
    case 'lost':
      return done(lose(app.db, lead, form.reason), false, 'stands');
    case 'skip':
      return done(skip(app.db, lead), false, 'stands');
    case 'stop':
      return done(stopLead(app.db, lead), false, 'stands');
    case 'reopen':
      return done(reopen(app.db, lead), false, 'stands');
    case 'notes':
      return done(saveNotes(app.db, lead, form.notes), false, 'stands');
    case 'delete': {
      const flash = removeLead(app.db, lead);
      return see(res, req, lead.stage === 'new' ? '/admin/leads' : '/admin/leads/reached', flash);
    }
    default:
      return send(res, 404, HTML, notFoundPage(csrfFor(token, app.secret)));
  }
}

async function webhook(app, req, res, url) {
  const m = metaSettings(app.env);
  if (req.method === 'GET') {
    const q = url.searchParams;
    if (q.get('hub.mode') === 'subscribe' && m.verifyToken && q.get('hub.verify_token') === m.verifyToken) return send(res, 200, 'text/plain; charset=utf-8', q.get('hub.challenge') || '');
    return send(res, 403, 'text/plain; charset=utf-8', 'no');
  }
  if (req.method !== 'POST') return send(res, 405, 'text/plain; charset=utf-8', 'method not allowed');
  const raw = await readBody(req, 2 * 1024 * 1024);
  if (!signatureOk(m.appSecret, raw, req.headers['x-hub-signature-256'])) {
    app.log('[webhook] refused: the signature does not match META_APP_SECRET');
    return send(res, 401, 'text/plain; charset=utf-8', 'bad signature');
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return send(res, 400, 'text/plain; charset=utf-8', 'not json');
  }
  await onWebhook(app, body);
  return send(res, 200, 'text/plain; charset=utf-8', 'ok');
}

async function customerAction(app, req, res, id, action, form, token) {
  const c = getCustomer(app.db, id);
  if (!c) return send(res, 404, HTML, notFoundPage(csrfFor(token, app.secret)));
  const back = (r, anchor = 'setup') => see(res, req, `/admin/customers/${c.id}#${anchor}`, r.flash, !r.ok);
  switch (action) {
    case 'edit':
      return back(updateCustomer(app.db, c, form), 'details');
    case 'activate':
    case 'pause':
    case 'stop':
      return back(setStatus(app.db, c, action));
    case 'number': {
      const r = await giveNumber(app, c);
      return back({ ok: r.ok, flash: r.ok ? TC.numbers.done(local(r.number)) : r.detail || TC.numbers.why[r.why] || r.why });
    }
    case 'billing':
      return back(updateBilling(app.db, c, form), 'billing');
    case 'pay-ask': {
      const r = await sendPayment(app, c, 'ask');
      return back({ ok: r.ok, flash: r.ok ? PAY.admin.asked : `${PAY.admin.blocked[r.why] || r.why}${r.detail ? ` ${r.detail}` : ''}` }, 'pay');
    }
    case 'pay-manual':
      try {
        const r = await manualPayment(app, c, form.expect);
        return back({ ok: true, flash: `${PAY.admin.manualDone(dateHe(r.bill.until))} ${invoiceFlash(r.invoice)}`.trim() }, 'pay');
      } catch (e) {
        if (e instanceof PayError) return back({ ok: false, flash: PAY.admin.errors[e.code] || e.code }, 'pay');
        throw e;
      }
    case 'end':
      return back(endAtMonthEnd(app.db, c), 'pay');
    case 'unend':
      return back(unend(app.db, c), 'pay');
    case 'skip-add':
      return back(addSkip(app.db, c, form.phone), 'skips');
    case 'skip-remove':
      return back(removeSkip(app.db, c, form.phone), 'skips');
    case 'delete':
      return see(res, req, '/admin/customers', removeCustomer(app.db, c));
    default:
      return send(res, 404, HTML, notFoundPage(csrfFor(token, app.secret)));
  }
}

/** What became of the invoice, in one line for the flash. */
function invoiceFlash(inv) {
  if (!inv || ['off', 'nothing', 'already'].includes(inv.state)) return '';
  return inv.state === 'issued' ? PAY.morning.flash.issued(inv.number) : PAY.morning.flash.failed;
}

/** "התשלום הגיע", "לא הגיע" and "להפיק חשבונית שוב" on a receipt's page. */
async function receiptAction(app, req, res, id, action, form) {
  const back = (flash, bad = false) => see(res, req, `/admin/receipts/${id}`, flash, bad);
  if (!receiptById(app.db, id)) return back(PAY.admin.errors.no_receipt, true);
  if (action === 'invoice') {
    const inv = await retryInvoice(app, id);
    return back(invoiceFlash(inv) || PAY.morning.off, inv.state !== 'issued');
  }
  try {
    const r = await decideReceipt(app, id, action === 'paid' ? 'paid' : 'not_paid', form.expect);
    return back(r.bill ? `${PAY.receipt.decided.paid(dateHe(r.bill.until))} ${invoiceFlash(r.invoice)}`.trim() : PAY.receipt.decided.not_paid);
  } catch (e) {
    if (e instanceof PayError) return back(PAY.admin.errors[e.code] || e.code, true);
    throw e;
  }
}

/** Telnyx: checked, answered at once (it waits 2 seconds at most), then handled. */
async function telnyxWebhook(app, req, res) {
  if (req.method !== 'POST') return send(res, 405, 'text/plain; charset=utf-8', 'method not allowed');
  const raw = await readBody(req, 1024 * 1024);
  const t = telnyxSettings(app.env);
  if (!telnyxSigned(t.publicKey, raw, req.headers['telnyx-signature-ed25519'], req.headers['telnyx-timestamp'], now())) {
    app.log('[telnyx] refused: the signature does not match TELNYX_PUBLIC_KEY');
    return send(res, 401, 'text/plain; charset=utf-8', 'bad signature');
  }
  let ev;
  try {
    ev = readEvent(JSON.parse(raw));
  } catch {
    return send(res, 400, 'text/plain; charset=utf-8', 'not json');
  }
  send(res, 200, 'text/plain; charset=utf-8', 'ok');
  if (ev.kind === 'call') track(app, onCall(app, ev));
}
