import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { faqOf, supportExport, textOf } from '../server/support.js';

test("Toran's file: the site's own facts, in the company export's shape, with 'join' as the way in", () => {
  const d = supportExport({ SITE_URL: 'https://alhakav.example' }, new Date('2026-11-21T10:00:00Z'));
  assert.equal(d.domain, 'alhakav.example');
  assert.equal(d.url, 'https://alhakav.example/');
  assert.equal(d.name, 'על הקו');
  assert.equal(d.start.kind, 'join');
  assert.equal(d.botName, 'הסוכן');
  assert.match(d.status, /מה עובד היום[\s\S]*מה עוד לא/);
  assert.deepEqual(d.plans.map((p) => [p.key, p.monthly]), [['monthly', 149]]);
  assert.match(d.plans[0].text, /175\.82 ₪ כולל מע״מ/);
  // Every question on the landing page, as it is written there, and the chat's own after them.
  const onSite = faqOf(readFileSync(new URL('../index.html', import.meta.url), 'utf8'));
  assert.ok(onSite.length >= 4);
  for (const f of onSite) assert.ok(d.faq.some((x) => x.q === f.q && x.a === f.a), f.q);
  assert.ok(d.faq.some((x) => x.q === 'איך משלמים?'));
  assert.equal(new Set(d.faq.map((f) => f.q)).size, d.faq.length);
  assert.deepEqual(d.pages.map((p) => p.kind), ['about', 'about', 'payment', 'terms', 'privacy', 'accessibility']);
  assert.ok(d.pages.every((p) => p.title && p.text.length > 100 && p.url.startsWith('https://alhakav.example/')));
  assert.equal(d.contact.whatsapp, '972515310498');
  assert.equal(d.generatedAt, '2026-11-21T10:00:00.000Z');
  // The owner's name stays on the privacy page, where the law asks for it, and out of what Toran says.
  assert.doesNotMatch(JSON.stringify(d), /יאנצבסקי/);
  assert.throws(() => supportExport({ SITE_URL: 'http://localhost:4760' }), /https/);
});

test('a page as text: a line for each paragraph, words kept apart, entities read', () => {
  assert.equal(textOf('<p class="amount"><b>149 <small>₪</small></b><span>לחודש</span></p><ul><li>א</li><li>ב &amp; ג</li></ul>'), '149 ₪ לחודש\n- א\n- ב & ג');
});
