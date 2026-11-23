import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { setNow } from '../server/clock.js';
import { createCustomer, getCustomer } from '../server/customers.js';
import { codeLine, sendSetup, setupCodes, setupText } from '../server/setup.js';
import { TORAN_ENV, fakeToran, testApp } from './helpers.js';

// The customer's setup message (server/setup.js). The owner, 2026-11-23: "Make sure the code is actually right and
// does[n't] get mixed up because of rtl!"

const NOW = Date.parse('2026-11-23T08:00:00Z');
const LRM = '‎';

beforeEach(() => setNow(NOW));
afterEach(() => setNow(null));

test('the codes come out exactly right: the one the owner dialed and saw work, and the two beside it', () => {
  assert.deepEqual(setupCodes('97243763889'), ['**61*043763889**20#', '**67*043763889#', '**62*043763889#']);
  // A ten-digit number (07X) keeps all its digits.
  assert.deepEqual(setupCodes('972771234567'), ['**61*0771234567**20#', '**67*0771234567#', '**62*0771234567#']);
  for (const bad of ['', null, '043763889', '97243763', '9724376388912345']) assert.equal(setupCodes(bad), null, String(bad));
});

test('in the Hebrew message each code stands alone on its line, left to right, in monospace, and nothing else touches it', () => {
  const codes = setupCodes('97243763889');
  const text = setupText({ business: 'אבי אינסטלציה' }, codes, '972552735207');
  const lines = text.split('\n');
  for (const code of codes) {
    // The whole line is the code: monospace, a left-to-right mark on each side, no Hebrew letter or space in it.
    assert.equal(lines.filter((l) => l === `\`\`\`${LRM}${code}${LRM}\`\`\``).length, 1, code);
    assert.equal(text.split(code).length, 2, `${code} once`);
  }
  assert.equal(codeLine('**61*043763889**20#'), '```‎**61*043763889**20#‎```');
  // The three come in the order they are explained: not answered, busy, off.
  assert.ok(text.indexOf(codes[0]) < text.indexOf(codes[1]) && text.indexOf(codes[1]) < text.indexOf(codes[2]));
  assert.match(text, /^✅ \*העוזר של אבי אינסטלציה מוכן\*\n/);
});

test('the bold and the emojis: every other line reads right to left, and each bold part opens and closes on its line', () => {
  const codes = setupCodes('97243763889');
  const text = setupText({ business: 'אבי אינסטלציה' }, codes, '972552735207');
  const words = text.split('\n').filter((l) => l && !l.startsWith('```'));
  for (const l of words) {
    // An emoji, then Hebrew; or Hebrew from the first letter. Never a digit, a Latin letter or a bare * first.
    assert.match(l, /^(?:\p{Extended_Pictographic}️? \*?)?[א-ת]/u, l);
    // WhatsApp's bold: *, a letter, ..., a letter or ? , *. Never an * next to a space inside, never one left open.
    const stars = l.match(/\*/g) || [];
    assert.equal(stars.length % 2, 0, l);
    for (const b of l.match(/\*[^*]*\*/g) || []) assert.match(b, /^\*\S[^*]*\S\*$/, b);
  }
  assert.deepEqual(
    words.filter((l) => /^\p{Extended_Pictographic}/u.test(l)).map((l) => l.split(' ')[0]),
    ['✅', '📞', '🧪', '🚫', '💬']
  );
});

test("it also says how to keep a number off המוקדן's messages and put it back, written to המוקדן at its own number", () => {
  const text = setupText({ business: 'אבי אינסטלציה' }, setupCodes('97243763889'), '972552735207');
  const [para] = text.split('\n\n').filter((x) => x.includes('לא לשלוח'));
  assert.equal(para, '🚫 *מישהו לא צריך לקבל הודעה מהמוקדן?*\nלמשל אמא או ספק. כותבים למוקדן בוואטסאפ, למספר 055-273-5207, "לא לשלוח" ואת המספר שלו, ככה: לא לשלוח 0501234567\nכדי שהוא יקבל שוב הודעות, כותבים למוקדן "לשלוח" ואת המספר.');
  // After the codes and the check, before the way to reach us.
  assert.ok(text.indexOf('**62*') < text.indexOf(para) && text.indexOf(para) < text.indexOf('אם משהו לא עובד'));
});

function setup() {
  const toran = fakeToran();
  const ctx = testApp({ env: TORAN_ENV, toranFetch: toran.f });
  const c = getCustomer(ctx.db, createCustomer(ctx.db, { name: 'אבי כהן', business: 'אבי אינסטלציה', trade: 'plumber', phone: '054-111-2222', assistant: '04-376-3889' }).id);
  const sent = () => ctx.graph.calls.filter((x) => x.url.endsWith('/messages')).map((x) => x.body);
  return { ...ctx, toran, c, sent };
}

test('as text while they wrote in the last 24 hours, else the template with the codes as its variables; once by itself', async () => {
  const { app, db, c, sent, toran } = setup();
  // No message from them yet: the template.
  assert.deepEqual(await sendSetup(app, c), { ok: true, how: 'template' });
  const [t] = sent();
  assert.equal(t.template.name, 'alhakav_setup');
  assert.deepEqual(
    t.template.components[0].parameters.map((p) => p.text),
    ['אבי אינסטלציה', `${LRM}**61*043763889**20#${LRM}`, `${LRM}**67*043763889#${LRM}`, `${LRM}**62*043763889#${LRM}`, '055-273-5207']
  );
  assert.match(toran.alerts.at(-1).title, /אבי אינסטלציה קיבלו את הקודים/);
  // By itself, once.
  assert.equal((await sendSetup(app, c)).why, 'sent');
  assert.equal(sent().length, 1);
  // They wrote to the business number: the admin's button sends it again, as text.
  db.run("INSERT INTO leads (domain, name, mobile, source, last_in_at, created_at, updated_at) VALUES (NULL, 'אבי', '972541112222', 'whatsapp', ?, ?, ?)", new Date(NOW - 3600_000).toISOString(), new Date(NOW).toISOString(), new Date(NOW).toISOString());
  assert.deepEqual(await sendSetup(app, c, { again: true }), { ok: true, how: 'text' });
  assert.equal(sent().at(-1).text.body, setupText(c, setupCodes(c.assistant), '972552735207'));
  assert.equal(db.get("SELECT count(*) AS n FROM messages WHERE kind = 'setup' AND status = 'sent'").n, 2);
});

test("when it cannot go, the owner gets the codes to send by hand; with no number, nothing goes", async () => {
  const { app, graph, c, toran } = setup();
  graph.fail = { code: 132001, message: 'Template name does not exist in the translation' };
  const r = await sendSetup(app, c);
  assert.equal(r.why, 'failed');
  const alert = toran.alerts.at(-1);
  assert.match(alert.title, /הקודים להעברת השיחות לא נשלחו לאבי אינסטלציה/);
  assert.ok(alert.body.includes(`\`\`\`${LRM}**61*043763889**20#${LRM}\`\`\``));
  assert.equal((await sendSetup(app, { ...c, assistant: null })).why, 'code');
});
