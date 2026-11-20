import { billingOf, dateHe, money } from './billing.js';
import { agoHe, dayMonth, hhmm } from './clock.js';
import { PAY } from './copy.js';
import { button, csrfField, esc, ext, flashLine, layout, tag } from './html.js';
import { payBlocked, payText } from './pay.js';
import { local } from './phones.js';

// The admin's side of paying (docs/payments.md): the payment card on a customer's page, the receipts that wait on the
// customers' list, and one page for each receipt, with the picture, what was owed, and the two buttons.

const A = PAY.admin;
const when = (iso) => `${dayMonth(Date.parse(iso))} ${hhmm(Date.parse(iso))}`;

/** The customer's state in a few words, and its tag kind. */
export function payState(c, b = billingOf(c)) {
  const text = { new: PAY.state.new, paid: PAY.state.paid(dateHe(b.paidUntil)), grace: PAY.state.grace(dateHe(b.graceUntil)), lapsed: PAY.state.lapsed, free: PAY.state.free, ending: PAY.state.ending(dateHe(b.endsOn)), ended: PAY.state.ended }[b.state];
  return { text, kind: b.state === 'paid' || b.state === 'free' ? '' : b.state === 'lapsed' || b.state === 'new' ? 'miss' : 'wait' };
}

const sumOf = (o) => A.sum({ total: money(o.total), net: money(o.net), vat: money(o.vat), from: dateHe(o.from), until: dateHe(o.until) });

function receiptRow(r) {
  const what =
    r.decision === 'paid' ? tag(PAY.state.paid(dateHe(r.bill?.until)), '') : r.decision === 'not_paid' ? tag(PAY.receipt.notPaid, 'wait') : tag(PAY.receipt.pending, 'due');
  const inv = r.morning_number ? tag(`חשבונית ${r.morning_number}`, 'where') : r.decision === 'paid' && r.morning_state && r.morning_state !== 'issued' ? tag('בלי חשבונית', 'miss') : '';
  return `<li><a href="/admin/receipts/${r.id}">${esc(when(r.created_at))}</a> ${esc(r.source === 'manual' ? PAY.receipt.manual : PAY.receipt.title)} ${what}${inv}</li>`;
}

/** The payment card on a customer's page. */
export function payCard(app, csrf, c, { receipts, notices }) {
  const b = billingOf(c);
  const st = payState(c, b);
  const blocked = payBlocked(app, c, b);
  const text = payText(app.env, c, b);
  const act = (action, label, kind = 'quiet', fields = {}) => button(`/admin/customers/${c.id}/${action}`, label, csrf, { kind, fields });
  const off = b.state === 'new' ? A.offNew : b.state === 'lapsed' ? A.offLapsed : '';
  const owed = b.owed
    ? `<p>${esc(A.owed(sumOf(b.owed)))}</p>
<details class="more"><summary>${esc(A.preview)}</summary><div class="chat"><div class="b out"><p dir="auto">${esc(text)}</p></div></div></details>
<div class="ops">${blocked ? `<p class="muted">${esc(A.blocked[blocked])}</p>` : act('pay-ask', A.ask, 'primary')}</div>
<details class="sure"><summary>${esc(A.manual)}</summary><p class="muted">${esc(A.manualHint)}</p>${act('pay-manual', A.manual, 'primary', { expect: c.paid_until || '' })}</details>`
    : `<p class="muted">${esc(A.nothing)}</p>`;
  const end = c.ends_on
    ? `<p>${act('unend', A.unend)}</p>`
    : b.state !== 'ended' && b.state !== 'free'
      ? `<details class="sure"><summary>${esc(A.end)}</summary><p class="muted">${esc(A.endHint)}</p>${act('end', A.end)}</details>`
      : '';
  const list = receipts.length ? `<ul class="facts">${receipts.map(receiptRow).join('')}</ul>` : `<p class="muted">${esc(A.noReceipts)}</p>`;
  const sent = notices.length
    ? `<h3>${esc(A.notices)}</h3><ul class="facts">${notices.map((n) => `<li>${esc(when(n.at))} ${esc(A.noticeKind[n.kind] || n.kind)} ${tag(A.noticeStatus[n.status] || n.status, n.status === 'failed' ? 'miss' : 'where')}</li>`).join('')}</ul>`
    : '';
  const chat = c.lead_id ? `<p><a href="/admin/leads/${c.lead_id}#chat">${esc(A.chat)}</a></p>` : '';
  return `<article class="card" id="pay"><h2>${esc(A.title)} ${tag(st.text, st.kind)}</h2>
${off ? `<p class="note">${esc(off)}</p>` : ''}${owed}${end}
<h3>${esc(A.receipts)}</h3>${list}${sent}${chat}</article>`;
}

/** The invoice details and the price, on a customer's page. */
export function billingCard(csrf, c) {
  const input = (name, value, attrs = '') => `<label>${esc(A.fields[name])}<input type="text" name="${name}" value="${esc(value ?? '')}" ${attrs}></label>`;
  return `<article class="card" id="billing"><h2>${esc(A.billing)}</h2><form method="post" action="/admin/customers/${c.id}/billing" class="fields">${csrfField(csrf)}
${input('price', c.price, 'required maxlength="10" dir="ltr" inputmode="decimal"')}
${input('invoice_name', c.invoice_name || c.business, 'maxlength="80" dir="auto"')}
${input('tax_id', c.tax_id, 'maxlength="20" dir="ltr" inputmode="numeric"')}
${input('address', c.address, 'maxlength="120" dir="auto"')}
${input('email', c.email, 'maxlength="120" dir="ltr" inputmode="email"')}
<label class="check"><input type="checkbox" name="free" value="1"${c.free ? ' checked' : ''}> ${esc(A.fields.free)}</label>
<button class="primary">${esc('לשמור')}</button></form></article>`;
}

/** The receipts that wait, at the top of the customers' list. */
export function waitingCard(rows, at) {
  if (!rows.length) return '';
  return `<article class="card" id="waiting"><h2>${esc(PAY.receipt.waiting)} ${tag(String(rows.length), 'due')}</h2><ul class="facts">${rows
    .map((r) => `<li><a href="/admin/receipts/${r.id}"><b>${esc(r.business)}</b></a> ${r.owed ? esc(`${money(r.owed.total)} ₪`) : ''} <span class="muted">${esc(agoHe(Date.parse(r.created_at), at))}</span></li>`)
    .join('')}</ul></article>`;
}

function morningLines(csrf, r) {
  if (r.decision !== 'paid') return '';
  const M = PAY.morning;
  if (r.morning_state === 'issued')
    return `<p>${esc(M.issued(r.morning_number))}${r.morning_url ? ` ${ext(r.morning_url, esc(M.open))}` : ''}</p>`;
  if (r.morning_state === 'issuing') return `<p class="muted">${esc(M.issuing)}</p><p class="muted">${esc(M.maybe)}</p>${button(`/admin/receipts/${r.id}/invoice`, M.retry, csrf, { kind: 'quiet' })}`;
  const e = r.morningError || {};
  if (r.morning_state === 'blocked') {
    const why = typeof M.blockedWhy[e.reason] === 'function' ? M.blockedWhy[e.reason](e.rate) : M.blockedWhy[e.reason] || '';
    return `<p class="note">${esc(M.blocked(why))}</p>${button(`/admin/receipts/${r.id}/invoice`, M.retry, csrf, { kind: 'quiet' })}`;
  }
  if (r.morning_state === 'failed')
    return `<p class="note">${esc(M.failed(M.why[e.code] || M.why.other, e.code))}</p>${e.detail ? `<p class="muted">${esc(M.said(e.detail))}</p>` : ''}${e.step === 'issue' && e.code === 'timeout' ? `<p class="muted">${esc(M.maybe)}</p>` : ''}${button(`/admin/receipts/${r.id}/invoice`, M.retry, csrf, { kind: 'quiet' })}`;
  return `<p class="muted">${esc(M.off)}</p>${button(`/admin/receipts/${r.id}/invoice`, M.retry, csrf, { kind: 'quiet' })}`;
}

/** One receipt: the picture, what was owed then and now, and the admin's answer. */
export function receiptPage({ csrf, flash = '', bad = false, r, c }) {
  const R = PAY.receipt;
  const file = !r.has_file
    ? r.source === 'manual'
      ? ''
      : `<p class="muted">${esc(R.noFile)}</p>`
    : r.type === 'application/pdf'
      ? `<p>${ext(`/admin/receipts/${r.id}/file`, esc(R.openPdf), 'button')}</p>`
      : `<p class="receipt"><img src="/admin/receipts/${r.id}/file" alt="${esc(R.image)}"></p>`;
  const now = c ? billingOf(c) : null;
  const facts = [
    r.source === 'manual' ? R.manual : R.from(local(r.phone)),
    when(r.created_at),
    r.owed && r.source !== 'manual' ? R.owedThen(sumOf(r.owed)) : '',
    now && !r.decided_at ? (now.owed ? R.owedNow(sumOf(now.owed)) : A.nothing) : '',
  ].filter(Boolean);
  const decide = !r.decided_at
    ? `<p class="note">${esc(R.check)}</p><div class="ops">${button(`/admin/receipts/${r.id}/paid`, R.paid, csrf, { kind: 'primary', fields: { expect: c?.paid_until || '' } })}${button(`/admin/receipts/${r.id}/not-paid`, R.notPaid, csrf, { kind: 'quiet' })}</div><p class="muted">${esc(R.notPaidHint)}</p>`
    : `<p>${tag(r.decision === 'paid' ? R.decided.paid(dateHe(r.bill?.until)) : R.decided.not_paid, r.decision === 'paid' ? '' : 'wait')}</p>`;
  const body = `${flashLine(flash, bad)}
<p><a href="${c ? `/admin/customers/${c.id}#pay` : '/admin/customers'}">← ${esc(c ? c.business : 'לקוחות')}</a></p>
<div class="head"><div><h1>${esc(R.title)}</h1><p class="tags">${esc(r.business)}</p></div></div>
<div class="cards"><article class="card"><ul class="facts">${facts.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>${file}${decide}${morningLines(csrf, r)}</article></div>`;
  return layout({ title: R.title, body, csrf, active: 'customers', reload: r.morning_state === 'issuing' ? 10 : 0 });
}

