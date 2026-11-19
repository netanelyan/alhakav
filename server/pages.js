import { agoHe, dayMonth, hhmm, whenHe } from './clock.js';
import { CLOSED, LOST, T, TRADE } from './copy.js';
import { button, csrfField, empty, esc, ext, flashLine, layout, ltr, tag } from './html.js';
import { laterDue } from './leads.js';
import { metaSettings } from './meta.js';
import { blocked, blockedText, messageText, nameParam, reminderDue, reminderDueAt, unreached, windowOpen, windowUntil } from './outreach.js';
import { isMobile, local } from './phones.js';
import { SEARCH_CITIES, SEARCH_TRADES } from './sources.js';

// The admin's pages, laid out like openfrequency-accounts' /admin/leads: a list of the leads we have not written to,
// one of the ones we have, and one page a lead with what to send first, then the conversation, where it stands, its
// details and, apart, its deletion. Every row and page works on a phone: a row wraps, its name and its button on top.

const leadButton = (csrf, id, action, label, kind = '', fields = {}) => button(`/admin/leads/${id}/${action}`, label, csrf, { kind, fields });

/** What is not set up yet, said once at the top of a list. */
function setupNotes(env, { list = 'leads' } = {}) {
  const m = metaSettings(env);
  const notes = [];
  if (!m.ready) notes.push(T.setup.meta);
  else if (!m.appSecret || !m.verifyToken) notes.push(T.setup.webhook);
  if (!String(env.SENDER_LINE || '').trim()) notes.push(T.setup.sender);
  if (list === 'leads' && !String(env.BRAVE_API_KEY || '').trim()) notes.push(T.setup.brave);
  return notes.length ? `<ul class="setup">${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : '';
}

/** Where our message got to, in one tag: red while it did not reach them, green once they did something, grey between. */
export function outTag(x) {
  if (x.source === 'whatsapp' && !x.first_at) return tag(T.out.inbound);
  const s = x.out_state;
  const kind = ['failed', 'undelivered', 'stopped'].includes(s) ? 'miss' : ['yes', 'replied'].includes(s) ? '' : 'wait';
  return tag(T.out[s] || s, kind);
}

const tradeTag = (x) => (x.trade ? tag(TRADE[x.trade], 'trade') : '');
const cityTag = (x) => (x.city ? tag(x.city, 'where') : '');

function tabs(base, items, current, counts, extra = {}) {
  const qs = (tab) => {
    const p = new URLSearchParams(Object.entries({ ...extra, tab }).filter(([, v]) => v));
    return `${base}${p.size ? `?${p}` : ''}`;
  };
  return `<nav class="tabs" aria-label="${esc(T.brand)}">${items.map(([k, label]) => `<a href="${esc(qs(k))}"${current === k ? ' aria-current="page"' : ''}>${esc(label)} <span class="n">${esc(counts[k] ?? 0)}</span></a>`).join('')}</nav>`;
}

const search = (action, q, tab) =>
  `<form class="row search" method="get" action="${action}" role="search">${tab ? `<input type="hidden" name="tab" value="${esc(tab)}">` : ''}<input type="search" name="q" value="${esc(q)}" maxlength="100" placeholder="${esc(T.leads.search)}" aria-label="${esc(T.leads.search)}"><button class="quiet">${esc(T.leads.searchGo)}</button></form>`;

// ---- sign-in

export function loginPage({ csrf, error = '', notSet = false }) {
  const body = `<section class="login card">
<h1>${esc(T.login.title)}</h1>
${notSet ? `<p class="flash bad" role="alert">${esc(T.login.notSet)}</p>` : flashLine(error, true)}
<form method="post" action="/admin/login">${csrfField(csrf)}
<label>${esc(T.login.password)}<input type="password" name="password" required autocomplete="current-password" dir="ltr" autofocus></label>
<button class="primary">${esc(T.login.go)}</button>
</form>
</section>`;
  return layout({ title: T.login.title, body, signedIn: false });
}

// ---- the leads we have not written to

function creating(csrf, env, discovery, run, at) {
  const add = `<form class="row" method="post" action="/admin/leads/add">${csrfField(csrf)}<input type="text" name="url" required maxlength="300" dir="ltr" inputmode="url" autocomplete="off" spellcheck="false" placeholder="${esc(T.leads.addPlaceholder)}" aria-label="${esc(T.leads.addLabel)}"><button class="quiet">${esc(T.leads.add)}</button></form>`;
  const brave = String(env.BRAVE_API_KEY || '').trim();
  let find = '';
  if (brave && discovery.running) find = `<p class="muted">${esc(T.leads.running)}</p>`;
  else if (brave) {
    const trades = `<select name="trade" aria-label="${esc(T.leads.findTrade)}"><option value="">${esc(T.leads.anyTrade)}</option>${Object.keys(SEARCH_TRADES).map((k) => `<option value="${k}">${esc(TRADE[k])}</option>`).join('')}</select>`;
    const city = `<input type="text" name="city" list="cities" maxlength="40" placeholder="${esc(T.leads.findCity)}" aria-label="${esc(T.leads.findCity)}"><datalist id="cities">${SEARCH_CITIES.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>`;
    find = `<details class="find"><summary>${esc(T.leads.find)}</summary><form class="row" method="post" action="/admin/discover">${csrfField(csrf)}${trades}${city}<button class="quiet">${esc(T.leads.findGo)}</button></form></details>`;
  }
  const lines = [];
  if (run?.stats && run.source === 'brave') lines.push(run.error ? T.leads.lastFailed(run.error) : T.leads.last(agoHe(Date.parse(run.finished_at), at), run.stats.looked || 0, run.stats.fit || 0));
  const daily = Number(env.DISCOVER_QUERIES ?? 3);
  if (brave && daily > 0) lines.push(T.leads.daily(daily));
  return `<div class="card create">${add}${find}${lines.map((l) => `<p class="muted">${esc(l)}</p>`).join('')}</div>`;
}

function newRow(csrf, x, metaReady, back) {
  const tags = [tradeTag(x), cityTag(x), tag(T.lead.score(x.score), x.qualified ? '' : 'wait'), x.mobile ? '' : tag(T.lead.noMobile, 'miss'), x.whatsapp_on_site ? tag(T.lead.waOnSite, 'where') : '', x.reject ? tag(x.reject, 'wait') : ''].join('');
  const go = x.mobile && metaReady ? leadButton(csrf, x.id, 'send', T.leads.send, 'primary', { stage: 'first', back }) : `<a class="button primary" href="/admin/leads/${x.id}#send">${esc(T.leads.open)}</a>`;
  return `<li id="lead-${x.id}"><div class="who"><a href="/admin/leads/${x.id}"><b>${esc(x.name)}</b></a>${x.domain ? ltr(x.domain, 'muted') : ''}</div><div class="acts">${go}${leadButton(csrf, x.id, 'skip', T.leads.skip, 'quiet', { back })}</div><div class="tags">${tags}</div>${x.about ? `<p class="about" dir="auto">${esc(x.about)}</p>` : ''}</li>`;
}

export function leadsPage({ csrf, flash = '', bad = false, env, tab, q, rows, counts, reachedAll, discovery, run, at }) {
  const metaReady = metaSettings(env).ready;
  const list = rows.length
    ? `<ul class="leads">${rows.map((x) => newRow(csrf, x, metaReady, 'list')).join('')}</ul>`
    : q
      ? empty(T.leads.empty, T.leads.noneFound(q))
      : empty(T.leads.empty, T.leads.emptyLead);
  const body = `${flashLine(flash, bad)}
<div class="head"><div><h1>${esc(T.leads.title)}</h1><p class="lead-line">${esc(T.leads.lead)}</p></div><a class="chip" href="/admin/leads/reached">${esc(T.reached.title)} <span class="n">${esc(reachedAll)}</span></a></div>
${setupNotes(env)}
${creating(csrf, env, discovery, run, at)}
${tabs('/admin/leads', Object.entries(T.leads.tabs), tab, counts, { q })}
${search('/admin/leads', q, tab)}
${list}`;
  return layout({ title: T.leads.title, body, csrf, active: 'leads', reload: discovery.running ? 20 : 0 });
}

// ---- the ones we wrote to

export function funnelLine(f) {
  if (!f.sent) return '';
  const part = (k, cls = '') => `<span${cls ? ` class="${cls}"` : ''}><b>${esc(f[k])}</b> ${esc(T.funnel[k][f[k] === 1 ? 0 : 1])}</span>`;
  const parts = [...['sent', 'delivered', 'read', 'yes', 'replied'].map((k) => part(k)), part('undelivered', f.undelivered ? 'bad' : ''), ...['stopped', 'customer'].filter((k) => f[k]).map((k) => part(k))];
  return `<p class="funnel">${parts.join('')}</p>`;
}

function reachedRow(x, last, at, showStage) {
  const tags = [
    outTag(x),
    reminderDue(x, at) ? tag(T.lead.due, 'due') : '',
    laterDue(x, at) ? tag(T.lead.laterDue, 'due') : x.later_until && x.stage !== 'closed' ? tag(T.lead.later(whenHe(Date.parse(x.later_until), at)), 'wait') : '',
    showStage ? tag(T.stage[x.stage], 'where') : '',
    x.stage === 'closed' && x.closed_why ? tag(CLOSED[x.closed_why] || x.closed_why, x.closed_why === 'customer' ? '' : 'wait') : '',
    tradeTag(x),
    cityTag(x),
  ].join('');
  const said = last ? `<p class="about"><span dir="auto">${esc(last.body.length > 90 ? `${last.body.slice(0, 90)}…` : last.body)}</span> <span class="muted">${esc(agoHe(Date.parse(last.at), at))}</span></p>` : '';
  return `<li id="lead-${x.id}"><div class="who"><a href="/admin/leads/${x.id}"><b>${esc(x.name)}</b></a>${x.domain ? ltr(x.domain, 'muted') : x.mobile ? ltr(local(x.mobile), 'muted') : ''}</div><div class="acts"><a class="button${reminderDue(x, at) || x.stage === 'talking' ? ' primary' : ''}" href="/admin/leads/${x.id}">${esc(T.leads.open)}</a></div><div class="tags">${tags}</div>${said}</li>`;
}

export function reachedPage({ csrf, flash = '', bad = false, env, tab, q, rows, counts, funnel, lastIns, at }) {
  const items = [...Object.entries(T.reached.tabs).filter(([k]) => k !== 'all'), ['', T.reached.tabs.all]];
  const list = rows.length ? `<ul class="leads">${rows.map((x) => reachedRow(x, lastIns.get(x.id), at, !tab)).join('')}</ul>` : q ? empty(T.leads.empty, T.leads.noneFound(q)) : empty(T.reached.empty, T.reached.emptyLead);
  const body = `${flashLine(flash, bad)}
<p><a href="/admin/leads">← ${esc(T.reached.back)}</a></p>
<div class="head"><div><h1>${esc(T.reached.title)}</h1><p class="lead-line">${esc(T.reached.lead)}</p></div></div>
${funnelLine(funnel)}
${setupNotes(env, { list: 'reached' })}
${tabs('/admin/leads/reached', items, tab, { ...counts, '': counts.all }, { q })}
${search('/admin/leads/reached', q, tab)}
${list}`;
  return layout({ title: T.reached.title, body, csrf, active: 'reached' });
}

// ---- one lead

function compose(app, csrf, x, stage, at) {
  const m = metaSettings(app.env);
  const b = blocked(app, x, stage, { at, byHand: !m.ready });
  const guard = b ? `<p class="note">${esc(blockedText(b, at))}</p>` : '';
  if (m.ready) {
    const hand = messageText(stage, x, app.env, { byHand: true });
    return `<p class="muted">${esc(T.send.asRead)}</p><blockquote class="msg" dir="rtl">${esc(messageText(stage, x, app.env))}</blockquote>${guard}
${b ? '' : `<div class="row">${leadButton(csrf, x.id, 'send', stage === 'first' ? T.send.first : T.send.reminder, 'primary', { stage })}</div>`}
<details class="more"><summary>${esc(T.send.copyOpen)}</summary><textarea id="msg-${stage}" rows="8" readonly dir="rtl" aria-label="${esc(T.send.asRead)}">${esc(hand)}</textarea><div class="row"><a class="button" href="${esc(waLink(x.mobile, hand))}" target="_blank" rel="noopener noreferrer" data-copy="#msg-${stage}">${esc(T.send.copyOpen)}</a>${leadButton(csrf, x.id, 'mark-sent', stage === 'first' ? T.send.markSent : T.send.markReminded, '', { stage })}</div></details>`;
  }
  const text = messageText(stage, x, app.env, { byHand: true });
  return `<p class="muted">${esc(T.send.asRead)}</p><textarea id="msg-${stage}" rows="9" readonly dir="rtl" aria-label="${esc(T.send.asRead)}">${esc(text)}</textarea>${guard}
<div class="row"><a class="button primary" href="${esc(waLink(x.mobile, text))}" target="_blank" rel="noopener noreferrer" data-copy="#msg-${stage}">${esc(T.send.copyOpen)}</a>${leadButton(csrf, x.id, 'mark-sent', stage === 'first' ? T.send.markSent : T.send.markReminded, '', { stage })}</div>`;
}

const waLink = (phone, text) => `https://wa.me/${phone}${text ? `?text=${encodeURIComponent(text)}` : ''}`;

function nameForm(csrf, x) {
  return `<details class="more"><summary>${esc(T.send.nameTitle)}: <b>${esc(nameParam(x))}</b></summary><form method="post" action="/admin/leads/${x.id}/name" class="row">${csrfField(csrf)}<input type="text" name="name" value="${esc(x.msg_name || x.name)}" maxlength="60" dir="auto" aria-label="${esc(T.send.nameTitle)}"><button class="quiet">${esc(T.send.nameSave)}</button></form><p class="muted">${esc(T.send.nameHint)}</p></details>`;
}

function sendCard(app, csrf, x, isStopped, at) {
  const went = x.first_at ? `<p class="out-line">${outTag(x)} <span class="muted">${esc(T.send.went(dayMonth(Date.parse(x.first_at)), x.out_by))}${x.reminder_at ? ` ${esc(T.send.reminderWent(dayMonth(Date.parse(x.reminder_at))))}` : ''}</span></p>` : '';
  let next;
  if (isStopped) next = `<p class="bad">${esc(T.guard.stopped)}</p>`;
  else if (!isMobile(x.mobile)) next = `<p class="bad">${esc(T.guard.noMobile)}</p>`;
  else if (x.stage === 'closed') next = `<p class="muted">${esc(T.guard.closed)}</p>`;
  else if (!x.first_at) next = `${compose(app, csrf, x, 'first', at)}${nameForm(csrf, x)}`;
  else if (x.yes_at || x.replied_at) next = `<p class="muted">${esc(T.send.answered)}</p>`;
  else if (unreached(x)) next = `<p class="bad">${esc(T.guard.unreached)}</p>`;
  else if (x.reminder_at) next = `<p class="muted">${esc(T.send.done)}</p>`;
  else if (reminderDueAt(x) > at) next = `<p class="muted">${esc(T.send.notDue(whenHe(reminderDueAt(x), at)))}</p>`;
  else next = `${compose(app, csrf, x, 'reminder', at)}${nameForm(csrf, x)}`;
  return `<article class="card" id="send"><h2>${esc(T.send.title)}</h2>${went}${next}</article>`;
}

function bubble(msg) {
  const t = Date.parse(msg.at);
  const kind = msg.dir === 'out' ? T.chat.kind[msg.kind] : msg.kind === 'auto' ? T.chat.auto : '';
  const status = msg.dir === 'out' && msg.status ? ` · ${T.chat.status[msg.status] || msg.status}` : '';
  return `<div class="b ${msg.dir}${msg.kind === 'auto' ? ' auto' : ''}${msg.status === 'failed' ? ' failed' : ''}">${kind ? `<small class="k">${esc(kind)}</small>` : ''}<p dir="auto">${esc(msg.body)}</p><time>${esc(`${dayMonth(t)} ${hhmm(t)}${status}`)}</time>${msg.error ? `<small class="bad">${esc(msg.error)}</small>` : ''}</div>`;
}

function chatCard(app, csrf, x, messages, at) {
  const m = metaSettings(app.env);
  const chat = messages.length ? `<div class="chat">${messages.map(bubble).join('')}</div>` : `<p class="muted">${esc(T.chat.none)}</p>`;
  let box = '';
  if (x.last_in_at && windowOpen(x, at)) {
    box = `<p class="muted">${esc(T.chat.open(whenHe(windowUntil(x), at)))}</p>${
      m.ready
        ? `<form method="post" action="/admin/leads/${x.id}/reply" class="reply">${csrfField(csrf)}<label>${esc(T.chat.replyLabel)}<textarea name="text" rows="3" maxlength="4000" dir="auto" required></textarea></label><button class="primary">${esc(T.chat.send)}</button></form>`
        : `<p class="muted">${esc(T.setup.meta)}</p>`
    }`;
  } else if (x.last_in_at) box = `<p class="muted">${esc(T.chat.closed)}</p>`;
  return `<article class="card" id="chat"><h2>${esc(T.chat.title)}</h2>${chat}${box}</article>`;
}

function standsCard(csrf, x, at) {
  const ops = (action, label, fields = {}) => leadButton(csrf, x.id, action, label, 'quiet', fields);
  const lost = `<details class="sure"><summary>${esc(T.stands.lost)}</summary><form method="post" action="/admin/leads/${x.id}/lost" class="row">${csrfField(csrf)}<select name="reason" aria-label="${esc(T.stands.lostWhy)}">${Object.entries(LOST)
    .map(([k, v]) => `<option value="${k}">${esc(v)}</option>`)
    .join('')}</select><button class="danger">${esc(T.stands.lostSave)}</button></form></details>`;
  let acts;
  if (x.stage === 'closed') acts = x.closed_why === 'stopped' ? '' : ops('reopen', T.stands.reopen);
  else if (x.stage === 'new') acts = `${ops('skip', T.stands.skip)}${ops('later', T.stands.tomorrow, { days: 1 })}`;
  else acts = `${x.replied_at ? '' : ops('replied', T.stands.replied)}${ops('customer', T.stands.customer)}${ops('later', T.stands.tomorrow, { days: 1 })}${ops('later', T.stands.week, { days: 7 })}${lost}`;
  const state = [
    tag(T.stage[x.stage], 'where'),
    x.stage === 'closed' && x.closed_why ? tag(CLOSED[x.closed_why] || x.closed_why, x.closed_why === 'customer' ? '' : 'wait') : '',
    laterDue(x, at) ? tag(T.lead.laterDue, 'due') : x.later_until && x.stage !== 'closed' ? tag(T.lead.later(whenHe(Date.parse(x.later_until), at)), 'wait') : '',
  ].join('');
  return `<article class="card" id="stands"><h2>${esc(T.stands.title)} ${state}</h2>${acts ? `<div class="ops">${acts}</div>` : ''}
<form method="post" action="/admin/leads/${x.id}/notes" class="notes">${csrfField(csrf)}<label>${esc(T.stands.notes)}<textarea name="notes" rows="3" maxlength="4000" dir="auto">${esc(x.notes)}</textarea></label><button class="quiet">${esc(T.stands.notesSave)}</button></form></article>`;
}

function detailsCard(x, at) {
  const p = JSON.parse(x.phones || '{}');
  const detail = JSON.parse(x.detail || '{}');
  const found = T.details.sources[x.source]?.(detail.query || '') || x.source;
  const lines = [
    x.mobile ? `<li>${esc(T.details.mobile)}: ${ext(`https://wa.me/${x.mobile}`, ltr(local(x.mobile)))}</li>` : '',
    (p.others || []).length ? `<li>${esc(T.details.others)}: ${p.others.map((n) => `<a href="tel:+${esc(n)}">${ltr(local(n))}</a>`).join(', ')}</li>` : '',
    (p.mobiles || []).filter((n) => n !== x.mobile).length ? `<li>${esc(T.details.others)}: ${p.mobiles.filter((n) => n !== x.mobile).map((n) => ltr(local(n))).join(', ')}</li>` : '',
    (p.specials || []).length ? `<li>${esc(T.details.specials)}: ${p.specials.map((n) => ltr(n)).join(', ')}</li>` : '',
    x.url ? `<li>${esc(T.details.site)}: ${ext(x.url, ltr(x.domain || x.url))}</li>` : '',
    `<li>${esc(T.details.found)}: ${esc(found)}</li>`,
    `<li>${esc(T.details.added)}: ${esc(`${dayMonth(Date.parse(x.created_at))}, ${agoHe(Date.parse(x.created_at), at)}`)}</li>`,
  ].join('');
  const b = JSON.parse(x.breakdown || '[]');
  const score = b.length
    ? `<details class="more"><summary>${esc(T.details.scoreTitle(x.score))}</summary><ul class="score">${b
        .map((f) => `<li class="${f.points < 0 ? 'bad' : ''}"><b>${esc(T.details.factor[f.factor] || f.factor)}</b> ${ltr(f.max ? `${f.points}/${f.max}` : String(f.points))} <span class="muted" dir="auto">${esc(f.evidence)}</span></li>`)
        .join('')}</ul></details>`
    : '';
  return `<article class="card" id="details"><h2>${esc(T.details.title)}</h2><ul class="facts">${lines}</ul>${x.reject ? `<p class="muted">${esc(T.details.reject(x.reject))}</p>` : ''}${score}</article>`;
}

function endCard(csrf, x) {
  return `<article class="card end" id="end"><h2>${esc(T.end.title)}</h2><details class="sure"><summary>${esc(T.end.remove)}</summary><p class="muted">${esc(T.end.hint)}</p>${leadButton(csrf, x.id, 'delete', T.end.sure, 'danger')}</details></article>`;
}

export function leadPage(app, { csrf, flash = '', bad = false, lead: x, messages, isStopped, at }) {
  const back = x.stage === 'new' ? ['/admin/leads', T.reached.back] : ['/admin/leads/reached', T.reached.title];
  const tags = [tradeTag(x), cityTag(x), x.stage === 'new' ? tag(T.lead.score(x.score), x.qualified ? '' : 'wait') : outTag(x), reminderDue(x, at) ? tag(T.lead.due, 'due') : ''].join('');
  const body = `${flashLine(flash, bad)}
<p><a href="${back[0]}">← ${esc(back[1])}</a></p>
<div class="head"><div><h1>${esc(x.name)}</h1><p class="tags">${x.url ? ext(x.url, ltr(x.domain || x.url)) : x.mobile ? ltr(local(x.mobile), 'muted') : ''} ${tags}</p>${x.about ? `<p class="about" dir="auto">${esc(x.about)}</p>` : ''}</div></div>
<div class="cards">
${sendCard(app, csrf, x, isStopped, at)}
${chatCard(app, csrf, x, messages, at)}
${standsCard(csrf, x, at)}
${detailsCard(x, at)}
${endCard(csrf, x)}
</div>`;
  return layout({ title: x.name, body, csrf, active: x.stage === 'new' ? 'leads' : 'reached' });
}

export function notFoundPage(csrf, signedIn = true) {
  return layout({ title: T.notFound, body: `<p><a href="/admin/leads">← ${esc(T.reached.back)}</a></p>${empty(T.notFound)}`, csrf, signedIn });
}
