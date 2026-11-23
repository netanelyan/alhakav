import { ownerNumber } from './alerts.js';
import { dayMonth, hhmm, israelDate, now, nowIso, whenHe } from './clock.js';
import { T } from './copy.js';
import { csrfField, empty, esc, layout, ltr, tag, waHtml } from './html.js';
import { windowOpen, windowUntil } from './outreach.js';
import { local } from './phones.js';

// The inbox: every WhatsApp message we sent and got, on both our numbers, as a plain list of conversations, the
// newest on top, and each one as its chat. The owner, 2026-11-22: "have there an inbox of the whatsapps we recieve and
// send, just a regular inbox".
//
//   biz      the business number (051): leads, customers about paying, Toran's answers, the owner's own alerts
//            (`messages`). The admin answers from here inside the 24 hours, as from a lead's page.
//   assist   המוקדן: each customer's callers, the customers themselves, and the tries from the leads' pages
//            (`chat_messages`, `demo_messages`). Read only: המוקדן talks there by itself.
//
// A conversation is unread while its newest message from them is newer than the last time it was opened here (kv).

export const LINES = ['biz', 'assist'];
const LIMIT = 300;

const seenKey = (line, phone) => `seen:${line}:${phone}`;
const short = (s, n = 90) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/** Who a phone is on a line, in a few words, and the admin page about them. */
function whoOn(db, env, line, phone) {
  if (phone === ownerNumber(env)) return { name: T.inbox.me, href: '' };
  if (line === 'biz') {
    const c = db.get('SELECT id, business FROM customers WHERE phone = ? ORDER BY id DESC LIMIT 1', phone);
    const lead = db.get('SELECT id, name FROM leads WHERE mobile = ? ORDER BY (first_at IS NULL), id DESC LIMIT 1', phone);
    if (c) return { name: c.business, href: `/admin/customers/${c.id}`, note: T.inbox.customer };
    if (lead) return { name: lead.name, href: `/admin/leads/${lead.id}` };
    return { name: local(phone), href: '' };
  }
  const c = db.get('SELECT id, business FROM customers WHERE phone = ? ORDER BY id DESC LIMIT 1', phone);
  if (c) return { name: c.business, href: `/admin/customers/${c.id}`, note: T.inbox.customer };
  const chat = db.get('SELECT c.id, c.business FROM chats h JOIN customers c ON c.id = h.customer_id WHERE h.caller = ? ORDER BY h.id DESC LIMIT 1', phone);
  if (chat) return { name: local(phone), href: `/admin/customers/${chat.id}`, note: T.inbox.caller(chat.business) };
  const demo = db.get('SELECT l.id, l.name FROM demos d JOIN leads l ON l.id = d.lead_id WHERE d.phone = ? ORDER BY d.id DESC LIMIT 1', phone);
  if (demo) return { name: demo.name, href: `/admin/leads/${demo.id}`, note: T.inbox.demo };
  if (db.get('SELECT 1 FROM demos WHERE phone = ? AND sample IS NOT NULL LIMIT 1', phone)) return { name: local(phone), href: '', note: T.inbox.sample };
  return { name: local(phone), href: '' };
}

// The newest message of each phone (ties by id), with how many there are and when they last wrote (an away message
// left out).
const NEWEST = (from, phone) => `SELECT * FROM (SELECT ${phone} AS phone, dir, kind, body, status, at, row_number() OVER w AS rn, count(*) OVER p AS n,
  max(CASE WHEN dir = 'in' AND kind != 'auto' THEN at END) OVER p AS last_in FROM ${from}
  WINDOW p AS (PARTITION BY ${phone}), w AS (PARTITION BY ${phone} ORDER BY at DESC, id DESC)) WHERE rn = 1`;

/** The newest message of each phone on a line: המוקדן's side joins the callers' chats and the tries. */
function lastOf(db, line) {
  if (line === 'biz') return db.all(NEWEST('messages', 'phone'));
  const map = new Map();
  const add = (r) => {
    const had = map.get(r.phone);
    if (!had) return map.set(r.phone, r);
    const newer = r.at > had.at ? r : had;
    map.set(r.phone, { ...newer, n: had.n + r.n, last_in: [had.last_in, r.last_in].filter(Boolean).sort().at(-1) || null });
  };
  for (const r of db.all(NEWEST('chat_messages', 'peer'))) add(r);
  for (const r of db.all(NEWEST('(SELECT m.id, d.phone, m.dir, m.kind, m.body, NULL AS status, m.at FROM demo_messages m JOIN demos d ON d.id = m.demo_id)', 'phone'))) add(r);
  return [...map.values()];
}

/** Every conversation, the newest first. tab: '' all, 'biz', 'assist' or 'unread'; q: a name, a number or words. */
export function conversations(db, env, { tab = '', q = '' } = {}) {
  const lines = LINES.includes(tab) ? [tab] : LINES;
  let rows = lines.flatMap((line) =>
    lastOf(db, line).map((r) => {
      const seen = db.kv(seenKey(line, r.phone));
      return { ...r, line, ...whoOn(db, env, line, r.phone), unread: Boolean(r.last_in && (!seen || r.last_in > seen)) };
    })
  );
  if (tab === 'unread') rows = rows.filter((r) => r.unread);
  const s = String(q || '').trim();
  if (s) {
    const digits = s.replace(/\D/g, '');
    rows = rows.filter((r) => r.name.includes(s) || (r.note || '').includes(s) || String(r.body).includes(s) || (digits.length >= 3 && (r.phone.includes(digits) || `0${r.phone.slice(3)}`.includes(digits))));
  }
  return rows.sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 200);
}

export const unreadCount = (db, env) => conversations(db, env, { tab: 'unread' }).length;

/** One conversation, oldest first (its newest LIMIT messages). */
export function thread(db, line, phone) {
  const rows =
    line === 'biz'
      ? db.all('SELECT dir, kind, body, status, error, at FROM messages WHERE phone = ? ORDER BY at DESC, id DESC LIMIT ?', phone, LIMIT)
      : db.all(
          "SELECT dir, kind, body, status, error, at FROM chat_messages WHERE peer = ? UNION ALL SELECT m.dir, CASE m.kind WHEN 'summary' THEN 'demoSummary' ELSE m.kind END, m.body, NULL, NULL, m.at FROM demo_messages m JOIN demos d ON d.id = m.demo_id WHERE d.phone = ? ORDER BY at DESC LIMIT ?",
          phone,
          phone,
          LIMIT
        );
  return rows.reverse();
}

export const markSeen = (db, line, phone) => db.kv(seenKey(line, phone), nowIso());

/** The lead whose 24 hours an answer from the business number rides on. */
export const leadOf = (db, phone) => db.get('SELECT * FROM leads WHERE mobile = ? ORDER BY (first_at IS NULL), id DESC LIMIT 1', phone);

// ---- the pages

const when = (iso, at) => {
  const t = Date.parse(iso);
  return israelDate(t) === israelDate(at) ? hhmm(t) : dayMonth(t);
};

// The first letter of a name, or a person's outline for someone known only by their number.
const PERSON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>';
const initial = (name) => {
  const c = (String(name).trim().match(/[\p{L}\p{N}]/u) || [''])[0];
  return /\p{L}/u.test(c) ? esc(c) : PERSON;
};

function row(r, at, current) {
  const href = `/admin/inbox/${r.line}/${r.phone}`;
  const mine = r.dir === 'out' ? `${T.inbox.we} ` : '';
  const on = current && current.line === r.line && current.phone === r.phone;
  return `<li${r.unread ? ' class="unread"' : ''}><a href="${href}"${on ? ' aria-current="page"' : ''}><span class="av ${r.line}" aria-hidden="true">${initial(r.name)}</span><span class="cv"><span class="cv-top"><b dir="auto">${esc(r.name)}</b><time>${esc(when(r.at, at))}</time></span><span class="cv-sub">${tag(T.inbox.lines[r.line], r.line === 'assist' ? 'trade' : 'where')}${r.note ? `<span class="muted">${esc(r.note)}</span>` : ''}</span><span class="cv-last" dir="auto">${esc(mine)}${esc(short(r.body))}</span></span>${r.unread ? `<span class="dot" aria-label="${esc(T.inbox.unread)}"></span>` : ''}</a></li>`;
}

function list(rows, at, current) {
  return rows.length ? `<ul class="convs">${rows.map((r) => row(r, at, current)).join('')}</ul>` : empty(T.inbox.empty, T.inbox.emptyLead);
}

function tabsOf(tab, q, counts) {
  const items = [['', T.inbox.tabs.all], ['unread', T.inbox.tabs.unread], ['biz', T.inbox.lines.biz], ['assist', T.inbox.lines.assist]];
  const qs = (k) => {
    const p = new URLSearchParams(Object.entries({ tab: k, q }).filter(([, v]) => v));
    return `/admin/inbox${p.size ? `?${p}` : ''}`;
  };
  return `<nav class="tabs" aria-label="${esc(T.inbox.title)}">${items.map(([k, label]) => `<a href="${esc(qs(k))}"${tab === k ? ' aria-current="page"' : ''}>${esc(label)}${k === 'unread' ? ` <span class="n">${esc(counts.unread)}</span>` : ''}</a>`).join('')}</nav>`;
}

const searchForm = (tab, q) =>
  `<form class="row search" method="get" action="/admin/inbox" role="search">${tab ? `<input type="hidden" name="tab" value="${esc(tab)}">` : ''}<input type="search" name="q" value="${esc(q)}" maxlength="100" placeholder="${esc(T.inbox.search)}" aria-label="${esc(T.inbox.search)}"><button class="quiet">${esc(T.leads.searchGo)}</button></form>`;

export function inboxPage({ csrf, flash = '', bad = false, rows, tab, q, counts, at = now() }) {
  const body = `${flash ? `<p class="flash${bad ? ' bad' : ''}" role="${bad ? 'alert' : 'status'}">${esc(flash)}</p>` : ''}
<div class="head"><div><h1>${esc(T.inbox.title)}</h1><p class="lead-line">${esc(T.inbox.lead)}</p></div></div>
${tabsOf(tab, q, counts)}
${searchForm(tab, q)}
${list(rows, at)}`;
  return layout({ title: T.inbox.title, body, csrf, active: 'inbox' });
}

function bubble(m) {
  const t = Date.parse(m.at);
  const kind = m.dir === 'out' ? T.inbox.kind[m.kind] ?? T.chat.kind[m.kind] ?? '' : m.kind === 'auto' ? T.chat.auto : '';
  const status = m.dir === 'out' && m.status ? ` · ${T.chat.status[m.status] || m.status}` : '';
  return `<div class="b ${m.dir}${m.kind === 'auto' ? ' auto' : ''}${m.status === 'failed' ? ' failed' : ''}">${kind ? `<small class="k">${esc(kind)}</small>` : ''}<p dir="auto">${waHtml(m.body)}</p><time>${esc(`${dayMonth(t)} ${hhmm(t)}${status}`)}</time>${m.error ? `<small class="bad">${esc(m.error)}</small>` : ''}</div>`;
}

export function threadPage({ csrf, flash = '', bad = false, line, phone, who, messages, lead, metaReady, rows, at = now() }) {
  let box;
  if (line === 'assist') box = `<p class="muted">${esc(T.inbox.assistOnly)}</p>`;
  else if (!lead || !lead.last_in_at) box = `<p class="muted">${esc(T.inbox.notYet)}</p>`;
  else if (!windowOpen(lead, at)) box = `<p class="muted">${esc(T.chat.closed)}</p>`;
  else if (!metaReady) box = `<p class="muted">${esc(T.setup.meta)}</p>`;
  else
    box = `<form method="post" action="/admin/inbox/biz/${phone}/reply" class="compose">${csrfField(csrf)}<label class="sr" for="reply-text">${esc(T.chat.replyLabel)}</label><textarea id="reply-text" name="text" rows="2" maxlength="4000" dir="auto" required placeholder="${esc(T.inbox.write)}"></textarea><button class="primary">${esc(T.chat.send)}</button></form><p class="muted small">${esc(T.chat.open(whenHe(windowUntil(lead), at)))}</p>`;
  const body = `${flash ? `<p class="flash${bad ? ' bad' : ''}" role="${bad ? 'alert' : 'status'}">${esc(flash)}</p>` : ''}
<div class="inbox">
<aside class="side" aria-label="${esc(T.inbox.title)}">${list(rows, at, { line, phone })}</aside>
<section class="thread" aria-labelledby="who">
<header class="th"><a class="back" href="/admin/inbox" aria-label="${esc(T.inbox.back)}">→</a><span class="av ${line}" aria-hidden="true">${initial(who.name)}</span><div><h1 id="who" dir="auto">${esc(who.name)}</h1><p class="muted">${[who.name === local(phone) ? '' : ltr(local(phone)), esc(T.inbox.lines[line]), who.note ? esc(who.note) : ''].filter(Boolean).join(' · ')}</p></div>${who.href ? `<a class="button" href="${esc(who.href)}">${esc(T.inbox.open)}</a>` : ''}</header>
<div class="chat">${messages.length ? messages.map(bubble).join('') : `<p class="muted">${esc(T.chat.none)}</p>`}</div>
<div class="reply-box">${box}</div>
</section>
</div>`;
  return layout({ title: who.name, body, csrf, active: 'inbox', wide: true });
}

