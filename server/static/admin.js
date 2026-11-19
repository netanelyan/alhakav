// The admin pages work without this. It only copies a message as its chat opens: the wa.me link already carries the
// text, the copy is for a chat that opens without it (openfrequency-accounts' static/admin.js, data-copy).
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-copy]');
  const box = a && document.querySelector(a.dataset.copy);
  if (!box || !navigator.clipboard) return;
  navigator.clipboard.writeText(box.value).catch(() => {});
});

// A conversation opens at its newest message.
for (const c of document.querySelectorAll('.chat')) c.scrollTop = c.scrollHeight;
