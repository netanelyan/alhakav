import { T } from './copy.js';

// The admin pages' bricks. Every value that is not ours goes through esc(); every form is a plain POST with its CSRF
// token, so every button works without script (openfrequency-accounts' src/web/html.js).

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const csrfField = (csrf) => `<input type="hidden" name="csrf" value="${esc(csrf)}">`;

const hidden = (fields) =>
  Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join('');

/** One button that posts: to `action`, with the CSRF token and `fields`. */
export const button = (action, label, csrf, { kind = '', fields = {} } = {}) =>
  `<form method="post" action="${esc(action)}" class="inline">${csrfField(csrf)}${hidden(fields)}<button${kind ? ` class="${kind}"` : ''}>${esc(label)}</button></form>`;

export const ext = (href, inner, cls = '') => `<a${cls ? ` class="${cls}"` : ''} href="${esc(href)}" target="_blank" rel="noopener noreferrer">${inner}</a>`;

export const tag = (text, kind = '') => `<span class="tag${kind ? ` ${kind}` : ''}">${esc(text)}</span>`;

export const ltr = (text, cls = '') => `<bdi class="ltr${cls ? ` ${cls}` : ''}">${esc(text)}</bdi>`;

export const flashLine = (flash, bad) => (flash ? `<p class="flash${bad ? ' bad' : ''}" role="${bad ? 'alert' : 'status'}">${esc(flash)}</p>` : '');

export const empty = (title, lead = '') => `<div class="card empty"><b>${esc(title)}</b>${lead ? `<p>${esc(lead)}</p>` : ''}</div>`;

/** A whole page: the bar (the lists and sign-out, once signed in) and the content. reload: seconds, while something runs. */
export function layout({ title, body, csrf = '', active = '', reload = 0, signedIn = true }) {
  const link = (href, label, on) => `<a href="${href}"${on ? ' aria-current="page"' : ''}>${esc(label)}</a>`;
  const nav = signedIn
    ? `<nav class="nav" aria-label="${esc(T.brand)}">${link('/admin/leads', T.nav.leads, active === 'leads')}${link('/admin/leads/reached', T.nav.reached, active === 'reached')}${link('/admin/customers', T.nav.customers, active === 'customers')}</nav>${button('/admin/logout', T.nav.logout, csrf, { kind: 'quiet' })}`
    : '';
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta name="theme-color" content="#0a7d4f">
${reload ? `<meta http-equiv="refresh" content="${Number(reload)}">\n` : ''}<title>${esc(title)} · ${esc(T.brand)}</title>
<link rel="stylesheet" href="/admin/static/admin.css">
<script src="/admin/static/admin.js" defer></script>
</head>
<body>
<header class="top"><div class="bar"><a class="brand" href="/admin/leads">${esc(T.brand)}</a>${nav}</div></header>
<main class="wrap">
${body}
</main>
</body>
</html>`;
}
