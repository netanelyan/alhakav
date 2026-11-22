// The admin pages work without this. It copies a message as its chat opens (the wa.me link already carries the text,
// the copy is for a chat that opens without it, openfrequency-accounts' static/admin.js data-copy), opens each
// conversation at its newest message, and shows on the bar how many conversations wait unread.
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-copy]');
  const box = a && document.querySelector(a.dataset.copy);
  if (!box || !navigator.clipboard) return;
  navigator.clipboard.writeText(box.value).catch(() => {});
});

for (const c of document.querySelectorAll('.chat')) c.scrollTop = c.scrollHeight;

const badge = document.querySelector('[data-unread]');
if (badge) {
  fetch('/admin/inbox/unread', { credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      if (!d || !d.n) return;
      badge.textContent = d.n > 99 ? '99+' : String(d.n);
      badge.hidden = false;
    })
    .catch(() => {});
}

// Enter sends a reply from the inbox; Shift+Enter is a new line.
const compose = document.querySelector('.compose textarea');
if (compose) {
  compose.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && compose.value.trim()) {
      e.preventDefault();
      compose.form.requestSubmit();
    }
  });
}
