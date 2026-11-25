import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MSG, PAY, SCENE, SVC } from '../server/copy.js';
import { DEMO } from '../server/demo.js';
import { waHtml } from '../server/html.js';
import { plainWords } from '../server/meta.js';
import { setupCodes, setupText } from '../server/setup.js';
import { templateDefs } from '../server/templates.js';
import { ENV } from './helpers.js';

// Every message the system writes has the setup message's look (copy.js), the owner, 2026-11-23: "The format is nice
// though, i want it to bee in all system messages".

const SENDER = 'על הקו, ישראל ישראלי, רחוב הדוגמה 1, אשדוד. alhakav.example';
const URL = 'https://alhakav.example/p/abcdefgh23';
const MESSAGES = {
  firstTrade: MSG.firstTrade('אצל אבי אינסטלציה', URL, SENDER, false, SCENE.plumber),
  firstTradeByHand: MSG.firstTrade('אצל אבי אינסטלציה', URL, SENDER, true, SCENE.ac),
  reminder: MSG.reminder('אצל אבי אינסטלציה', URL, SENDER, false),
  pitch: MSG.pitch('אבי אינסטלציה', URL),
  welcome: MSG.welcome('https://alhakav.example'),
  stopped: MSG.stopped,
  callerFirst: SVC.callerFirst('אבי אינסטלציה'),
  callerStopped: SVC.callerStopped,
  stranger: SVC.stranger('https://alhakav.example'),
  callerThanks: SVC.callerThanks('אבי אינסטלציה'),
  summary: SVC.summary({ time: '10:41', what: 'נזילה מתחת לכיור', place: 'הרצל 15, אשדוד', urgency: 'דחוף', phone: '054-123-4567' }),
  note: SVC.note({ time: '10:41', number: '054-123-4567', line: SVC.lines.noReply }),
  help: SVC.owner.help(),
  skipped: SVC.owner.skipped('054-123-4567'),
  unskipped: SVC.owner.unskipped('054-123-4567'),
  paused: SVC.owner.paused,
  resumed: SVC.owner.resumed,
  pay: PAY.message({ line: PAY.lines.first({ business: 'אבי אינסטלציה', from: '21.11.2026', until: '20.12.2026' }), amount: '175.82', details: 'בנק הפועלים (12), סניף 345, חשבון 678901, על שם ישראל ישראלי' }),
  received: PAY.received,
  again: PAY.again,
  againPaid: PAY.againPaid,
  unreadable: PAY.unreadable,
  tooLarge: PAY.tooLarge,
  paid: PAY.paid({ business: 'אבי אינסטלציה', until: '20.12.2026', url: 'https://example.com/invoice.pdf', setup: true }),
  setup: setupText({ business: 'אבי אינסטלציה' }, setupCodes('97243763889'), '972552735207'),
  demoIntro: DEMO.intro('אבי אינסטלציה'),
  demoClosing: DEMO.closing('אבי אינסטלציה', '972515310498'),
  demoFull: DEMO.full('972515310498'),
};

const EMOJI = /^\p{Extended_Pictographic}️? /u;

test('each starts with an emoji, every line reads right to left, and each bold part opens and closes on its line', () => {
  for (const [name, text] of Object.entries(MESSAGES)) {
    assert.match(text, EMOJI, name);
    for (const l of text.split('\n')) {
      // A line alone that is a code, a link or the identification line is left to right on purpose.
      if (!l || l.startsWith('```') || /^https?:\/\//.test(l) || l === SENDER) continue;
      // WhatsApp sets a line's direction by its first letter; emojis, digits, *, ₪ and punctuation do not count.
      assert.match(l.match(/\p{L}/u)?.[0] || '', /[א-ת]/, `${name}: ${l}`);
      assert.equal((l.match(/\*/g) || []).length % 2, 0, `${name}: ${l}`);
      for (const b of l.match(/\*[^*]*\*/g) || []) assert.match(b, /^\*[^*\s][^*]*[^*\s]\*$/, `${name}: ${b}`);
    }
  }
});

test("the templates to submit: Meta's rules, a sample for each variable, and each the same words as its text", () => {
  assert.throws(() => templateDefs({ ...ENV, SITE_URL: '' }), /SITE_URL/);
  const defs = templateDefs(ENV);
  assert.deepEqual(
    defs.map((t) => t.name),
    ['alhakav_page_trade_v2', 'alhakav_page_reminder_v3', 'alhakav_caller_v2', 'alhakav_summary_v2', 'alhakav_call_alert_v2', 'alhakav_payment_v2', 'alhakav_owner_alert_v2', 'alhakav_setup']
  );
  for (const t of defs) {
    const b = t.components.find((c) => c.type === 'BODY');
    // Never starts or ends with a variable, numbered 1.. in order, a sample for each, none with a line break.
    assert.doesNotMatch(b.text, /^\s*\{\{|\}\}\s*$/, t.name);
    const vars = [...b.text.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
    assert.deepEqual(vars, vars.map((_, i) => i + 1), t.name);
    assert.equal(b.example.body_text[0].length, vars.length, t.name);
    for (const v of b.example.body_text[0]) assert.doesNotMatch(v, /[\n\t]/, t.name);
    assert.ok(b.text.length <= 1024, `${t.name}: ${b.text.length}`);
    // Filled with its samples, it is the look's message, emoji first.
    const filled = b.text.replace(/\{\{(\d+)\}\}/g, (_, n) => b.example.body_text[0][n - 1]);
    assert.match(filled, /^\p{Extended_Pictographic}/u, t.name);
  }
  // The same words the server writes as plain text.
  const filled = (name) => {
    const b = defs.find((t) => t.name === name).components[0];
    return b.text.replace(/\{\{(\d+)\}\}/g, (_, n) => b.example.body_text[0][n - 1]);
  };
  assert.equal(filled('alhakav_caller_v2'), SVC.callerFirst('אבי אינסטלציה'));
  assert.equal(filled('alhakav_page_trade_v2'), MSG.firstTrade('אצל אבי אינסטלציה', URL, MSG.signature(ENV.SITE_URL), false, SCENE.plumber));
});

test('a page shows the bold as bold and the codes as they are, never a stray *', () => {
  assert.equal(waHtml(MESSAGES.summary).split('\n')[2], '📝 <strong>מה:</strong> נזילה מתחת לכיור');
  assert.ok(waHtml(MESSAGES.setup).includes('<code dir="ltr">‎**61*043763889**20#‎</code>'));
  assert.ok(!waHtml(MESSAGES.help).includes('*'));
  assert.equal(waHtml('2*3*4, <b>'), '2*3*4, &lt;b&gt;');
  // A caller's words in a summary carry none of WhatsApp's marks.
  assert.equal(plainWords(' *דחוף*  מאוד_~ '), 'דחוף מאוד');
});
