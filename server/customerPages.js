import { agoHe, dayMonth, hhmm } from './clock.js';
import { CALL_OUTCOME, CHAT_STATE, CUST_STATUS, TC, TRADE } from './copy.js';
import { forwardCodes } from './customers.js';
import { button, csrfField, empty, esc, flashLine, layout, ltr, tag } from './html.js';
import { billingCard, payCard, payState, waitingCard } from './payPages.js';
import { assistSettings } from './meta.js';
import { local } from './phones.js';
import { telnyxSettings } from './telnyx.js';
import { numberOf } from './numbers.js';

// The customers' pages in the admin: the list (with the transfer receipts that wait), and one page each with the setup
// in the order it happens (their number at Telnyx, the forwarding codes, turning it on), the payment,
// the "לא לשלוח" list, and the last conversations with what the summary said.

const statusKind = { active: '', setup: 'due', paused: 'wait', stopped: 'wait' };
const custButton = (csrf, id, action, label, kind = '', fields = {}) => button(`/admin/customers/${id}/${action}`, label, csrf, { kind, fields });

function setupNotes(app) {
  const t = telnyxSettings(app.env);
  const notes = [];
  if (!t.ready) notes.push(TC.setup.telnyx);
  if (!assistSettings(app.env).ready) notes.push(TC.setup.assist);
  if (!app.claude) notes.push(TC.setup.claude);
  return notes.length ? `<ul class="setup">${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : '';
}

function fieldsForm(csrf, action, c = {}, label = TC.save) {
  const input = (name, value, attrs = '') => `<label>${esc(TC.fields[name])}<input type="text" name="${name}" value="${esc(value || '')}" ${attrs}></label>`;
  const trade = `<label>${esc(TC.fields.trade)}<select name="trade"><option value=""></option>${Object.entries(TRADE)
    .map(([k, v]) => `<option value="${k}"${c.trade === k ? ' selected' : ''}>${esc(v)}</option>`)
    .join('')}</select></label>`;
  return `<form method="post" action="${action}" class="fields">${csrfField(csrf)}
${input('name', c.name, 'required maxlength="80" dir="auto"')}
${input('business', c.business, 'required maxlength="80" dir="auto"')}
${trade}
${input('phone', c.phone ? local(c.phone) : '', 'required maxlength="20" dir="ltr" inputmode="tel" placeholder="054-123-4567"')}
${input('assistant', c.assistant ? local(c.assistant) : '', 'maxlength="20" dir="ltr" inputmode="tel" placeholder="077-123-4567"')}
<button class="primary">${esc(label)}</button></form>`;
}

export function customersPage(app, { csrf, flash = '', bad = false, rows, waiting = [], at }) {
  const list = rows.length
    ? `<ul class="leads">${rows
        .map(
          (c) =>
            `<li><div class="who"><a href="/admin/customers/${c.id}"><b>${esc(c.business)}</b></a><span class="muted">${esc(c.name)}</span></div><div class="acts"><a class="button" href="/admin/customers/${c.id}">${esc('לפתוח')}</a></div><div class="tags">${tag(CUST_STATUS[c.status], statusKind[c.status])}${tag(payState(c).text, payState(c).kind)}${c.trade ? tag(TRADE[c.trade], 'trade') : ''}${tag(`${c.calls_week} שיחות השבוע`, 'where')}${c.last_call_at ? tag(`שיחה אחרונה ${agoHe(Date.parse(c.last_call_at), at)}`, 'where') : ''}</div></li>`
        )
        .join('')}</ul>`
    : empty(TC.empty, TC.emptyLead);
  const body = `${flashLine(flash, bad)}
<div class="head"><div><h1>${esc(TC.title)}</h1><p class="lead-line">${esc(TC.lead)}</p></div></div>
${setupNotes(app)}
${waitingCard(waiting, at)}
${list}
<details class="card more"><summary>${esc(TC.add)}</summary>${fieldsForm(csrf, '/admin/customers/new', {}, TC.create)}</details>`;
  return layout({ title: TC.title, body, csrf, active: 'customers' });
}

function setupCard(app, csrf, c, at) {
  const step = (done, title, inner) => `<li class="${done ? 'done' : ''}"><b>${esc(title)}</b>${inner}</li>`;
  const nr = numberOf(app.db, c);
  const assistant = c.assistant
    ? `<p>${ltr(local(c.assistant))}</p>${nr && !nr.active_at ? `<p class="note">${esc(TC.numbers.review)}</p>` : ''}`
    : `<p class="muted">${esc(TC.steps.assistantHint)}</p>${c.status === 'stopped' ? '' : `<div class="ops">${custButton(csrf, c.id, 'number', TC.numbers.buy, 'primary')}</div>`}`;
  const codes = c.assistant
    ? `<p class="muted">${esc(TC.steps.forwardHint)}</p><textarea id="codes" rows="4" readonly dir="ltr">${esc(forwardCodes(c.assistant).join('\n'))}</textarea><p class="note">${esc(TC.steps.forwardWarn)}</p><p class="muted">${esc(c.last_call_at ? TC.steps.lastCall(`${agoHe(Date.parse(c.last_call_at), at)}, ${dayMonth(Date.parse(c.last_call_at))} ${hhmm(Date.parse(c.last_call_at))}`) : TC.steps.noCall)}</p>`
    : '';
  const acts =
    c.status === 'active'
      ? `${custButton(csrf, c.id, 'pause', TC.steps.pause, 'quiet')}${custButton(csrf, c.id, 'stop', TC.steps.stop, 'quiet')}`
      : c.status === 'stopped'
        ? custButton(csrf, c.id, 'activate', TC.steps.activate, 'quiet')
        : `${custButton(csrf, c.id, 'activate', TC.steps.activate, c.assistant ? 'primary' : 'quiet')}${custButton(csrf, c.id, 'stop', TC.steps.stop, 'quiet')}`;
  return `<article class="card" id="setup"><h2>${esc(TC.steps.title)} ${tag(CUST_STATUS[c.status], statusKind[c.status])}</h2><ol class="steps">
${step(Boolean(c.assistant), TC.steps.assistant, assistant)}
${step(Boolean(c.last_call_at), TC.steps.forward, codes)}
${step(c.status === 'active', TC.steps.status, `<div class="ops">${acts}</div>`)}
</ol></article>`;
}

function skipsCard(csrf, c, skips) {
  const rows = skips.length
    ? `<ul class="facts">${skips.map((s) => `<li>${ltr(local(s.phone))} <span class="muted">${esc(TC.skips.why[s.why] || s.why)}</span> ${custButton(csrf, c.id, 'skip-remove', TC.skips.remove, 'quiet', { phone: s.phone })}</li>`).join('')}</ul>`
    : `<p class="muted">${esc(TC.skips.none)}</p>`;
  return `<article class="card" id="skips"><h2>${esc(TC.skips.title)}</h2><p class="muted">${esc(TC.skips.hint)}</p>${rows}
<form method="post" action="/admin/customers/${c.id}/skip-add" class="row">${csrfField(csrf)}<input type="text" name="phone" required maxlength="20" dir="ltr" inputmode="tel" placeholder="054-123-4567" aria-label="${esc(TC.skips.title)}"><button class="quiet">${esc(TC.skips.add)}</button></form></article>`;
}

function chatsCard(chats, calls, at) {
  const callLine = calls.length
    ? `<ul class="facts">${calls.map((x) => `<li>${esc(`${dayMonth(Date.parse(x.at))} ${hhmm(Date.parse(x.at))}`)} ${x.caller ? ltr(local(x.caller)) : esc('מספר חסוי')} ${tag(CALL_OUTCOME[x.outcome] || x.outcome, ['failed', 'hidden'].includes(x.outcome) ? 'miss' : 'where')}</li>`).join('')}</ul>`
    : '';
  const one = (x) => {
    const bubbles = x.messages
      .map((m) => `<div class="b ${m.dir}${m.kind === 'auto' ? ' auto' : ''}${m.status === 'failed' ? ' failed' : ''}"><p dir="auto">${esc(m.body)}</p><time>${esc(`${hhmm(Date.parse(m.at))}${m.dir === 'out' && m.status ? ` · ${m.status}` : ''}`)}</time></div>`)
      .join('');
    const summary = [x.what && `מה: ${x.what}`, x.place && `איפה: ${x.place}`, x.urgency && `דחיפות: ${x.urgency}`].filter(Boolean).join(' · ');
    return `<details class="more"><summary>${ltr(local(x.caller))} · ${esc(agoHe(Date.parse(x.opened_at), at))} ${tag(CHAT_STATE[x.state], x.state === 'failed' || x.state === 'stopped' ? 'miss' : x.state === 'done' ? '' : 'wait')}${x.calls > 1 ? tag(TC.chats.calls(x.calls), 'where') : ''}</summary>${summary ? `<p>${esc(summary)}</p>` : ''}<div class="chat">${bubbles}</div></details>`;
  };
  return `<article class="card" id="chats"><h2>${esc(TC.chats.title)}</h2>${callLine}${chats.length ? chats.map(one).join('') : `<p class="muted">${esc(TC.chats.none)}</p>`}</article>`;
}

export function customerPage(app, { csrf, flash = '', bad = false, c, skips, chats, calls, receipts = [], notices = [], at }) {
  const body = `${flashLine(flash, bad)}
<p><a href="/admin/customers">← ${esc(TC.back)}</a></p>
<div class="head"><div><h1>${esc(c.business)}</h1><p class="tags">${esc(c.name)} ${ltr(local(c.phone), 'muted')} ${c.trade ? tag(TRADE[c.trade], 'trade') : ''}</p></div></div>
${setupNotes(app)}
<div class="cards">
${setupCard(app, csrf, c, at)}
${payCard(app, csrf, c, { receipts, notices })}
${chatsCard(chats, calls, at)}
${skipsCard(csrf, c, skips)}
<article class="card" id="details"><h2>${esc('פרטים')}</h2>${fieldsForm(csrf, `/admin/customers/${c.id}/edit`, c)}</article>
${billingCard(csrf, c)}
<article class="card end" id="end"><h2>${esc(TC.end.title)}</h2><details class="sure"><summary>${esc(TC.end.remove)}</summary><p class="muted">${esc(TC.end.hint)}</p>${custButton(csrf, c.id, 'delete', TC.end.sure, 'danger')}</details></article>
</div>`;
  return layout({ title: c.business, body, csrf, active: 'customers' });
}
