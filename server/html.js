import { T } from './copy.js';

// The admin pages' bricks. Every value that is not ours goes through esc(); every form is a plain POST with its CSRF
// token, so every button works without script (openfrequency-accounts' src/web/html.js).

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * A WhatsApp message as a page shows it, escaped: ```monospace``` as <code>, and *bold* as <strong> where WhatsApp
 * would bold it (an * that opens before a letter and closes after one, on one line, outside the monospace).
 */
export const waHtml = (s) =>
  String(s ?? '')
    .split(/(```[^`\n]+```)/)
    .map((part, i) => (i % 2 ? `<code dir="ltr">${esc(part.slice(3, -3))}</code>` : esc(part).replace(/(^|[^*\p{L}\p{N}])\*([^*\s](?:[^*\n]*[^*\s])?)\*(?![*\p{L}\p{N}])/gmu, '$1<strong>$2</strong>')))
    .join('');

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

/**
 * A whole page, in the landing page's look: the navy bar with the logo, the lists and sign-out (once signed in), and
 * the content. reload: seconds, while something runs. wide: the inbox's two columns.
 */
export function layout({ title, body, csrf = '', active = '', reload = 0, signedIn = true, wide = false }) {
  const link = (href, label, on, extra = '') => `<a href="${href}"${on ? ' aria-current="page"' : ''}>${esc(label)}${extra}</a>`;
  const nav = signedIn
    ? `<nav class="nav" aria-label="${esc(T.brand)}">${link('/admin/inbox', T.nav.inbox, active === 'inbox', '<span class="badge" data-unread hidden></span>')}${link('/admin/leads', T.nav.leads, active === 'leads')}${link('/admin/leads/reached', T.nav.reached, active === 'reached')}${link('/admin/customers', T.nav.customers, active === 'customers')}</nav>${button('/admin/logout', T.nav.logout, csrf, { kind: 'out' })}`
    : '';
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta name="theme-color" content="#0B2340">
${reload ? `<meta http-equiv="refresh" content="${Number(reload)}">\n` : ''}<title>${esc(title)} · ${esc(T.brand)}</title>
<link rel="icon" href="/svg/al-hakav-favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Heebo:wght@400;500;700;800;900&amp;display=swap">
<link rel="stylesheet" href="/admin/static/admin.css">
<script src="/admin/static/admin.js" defer></script>
</head>
<body>
<header class="top"><div class="bar"><a class="brand" href="/admin/inbox"><img src="/svg/al-hakav-logo-on-dark.svg" alt="${esc(T.brand)}" width="118" height="28"></a>${nav}</div></header>
<main class="wrap${wide ? ' wide' : ''}">
${body}
</main>
</body>
</html>`;
}
