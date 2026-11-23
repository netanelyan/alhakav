import { adminLink, alertOwner } from './alerts.js';
import { nowIso } from './clock.js';
import { SETUP } from './copy.js';
import { forwardCodes } from './customers.js';
import { assistSettings, metaSettings, sendTemplate, sendText } from './meta.js';
import { local } from './phones.js';
import { keep, windowOpen } from './toCustomer.js';

// The customer's setup message, from the business number, the moment their own number at Telnyx works. The owner,
// 2026-11-23: "Yes i want that automatic message. Make sure the code is actually right and does[n't] get mixed up
// because of rtl!"
//
//   the codes  customers.js forwardCodes, the three the site promises (index.html, "אני צריך להחליף את המספר של
//              העסק?"): **61*<their number>**20# a call not answered in 20 seconds, the one the owner dialed on
//              2026-11-22 and saw work (**61*043763889**20#); **67*<number># one that comes while they are on another
//              call; **62*<number># one that comes while the phone is off or out of reach. Each is checked against its
//              shape, all on their own number, before anything goes.
//   RTL        in a Hebrew message the * and # are neutral and the digits weak, so a right-to-left line reorders them
//              (#20**043763889*61**). Each code stands on a line of its own, between left-to-right marks (U+200E),
//              inside WhatsApp's monospace (```), which also keeps "*61*" from turning into bold and eating asterisks.
//   when       numbers.js: a number given that already works, or a bought one the moment Telnyx makes it active; and
//              "לשלוח ללקוח את הקודים" on their page in the admin, which sends them again
//   on         the message says the assistant is ready and to test it with a call, so a customer still in setup is
//              turned on as it goes (in setup, service.js answers no call, not even the test)
//   the list   how to keep a number off המוקדן's messages ("לא לשלוח") and put it back ("לשלוח"), written to המוקדן
//              at its own number, which the message gives
//   how        plain text while they wrote to the business number in the last 24 hours, else the template
//              alhakav_setup (TEMPLATE_SETUP, docs/whatsapp-templates.md); if neither goes, the owner gets the codes
//              to send by hand

const SHAPES = [/^\*\*61\*(0\d{8,9})\*\*20#$/, /^\*\*67\*(0\d{8,9})#$/, /^\*\*62\*(0\d{8,9})#$/];
const LRM = '‎';

export const setupSettings = (env) => ({ template: String(env.TEMPLATE_SETUP || 'alhakav_setup') });

/** The three codes that forward their calls to their number (972...), or null when one does not come out right. */
export function setupCodes(assistant) {
  const digits = String(assistant || '');
  if (!/^972\d{8,9}$/.test(digits)) return null;
  const codes = forwardCodes(digits).slice(0, 3);
  const own = `0${digits.slice(3)}`;
  return codes.every((code, i) => SHAPES[i].exec(code)?.[1] === own) ? codes : null;
}

/** A code as it stands in a Hebrew message: left to right. As the template's variable, and as a line of plain text. */
export const codeVariable = (code) => `${LRM}${code}${LRM}`;
export const codeLine = (code) => `\`\`\`${codeVariable(code)}\`\`\``;

/** The message as the customer reads it, with המוקדן's number (972...) to write "לא לשלוח" to. */
export const setupText = (c, codes, assist) => SETUP.text({ business: c.business, codes: codes.map(codeLine), assist: local(assist) });

/** Whether it already went to them, for the automatic sends (the admin's button sends it again). */
export const setupSent = (db, c) => Boolean(db.get("SELECT 1 FROM messages WHERE phone = ? AND kind = 'setup' AND status = 'sent'", c.phone));

/** Send customer c their setup message. Answers { ok, how } or { ok: false, why, detail }. Never throws. */
export async function sendSetup(app, c, { again = false } = {}) {
  const codes = setupCodes(c.assistant);
  if (!codes) return { ok: false, why: 'code' };
  if (!again && setupSent(app.db, c)) return { ok: false, why: 'sent' };
  const m = metaSettings(app.env);
  const assist = assistSettings(app.env).number;
  if (!m.ready || !assist) return { ok: false, why: 'meta' };
  const page = adminLink(app.env, `/admin/customers/${c.id}#setup`);
  const body = setupText(c, codes, assist);
  const open = windowOpen(app.db, c.phone);
  try {
    const waId = open ? await sendText(m, app.graphFetch, c.phone, body) : await sendTemplate(m, app.graphFetch, c.phone, setupSettings(app.env).template, [c.business, ...codes.map(codeVariable), local(assist)]);
    keep(app.db, c, { kind: 'setup', body, waId: waId || null, status: 'sent' });
    app.db.run("UPDATE customers SET status = 'active', updated_at = ? WHERE id = ? AND status = 'setup'", nowIso(), c.id);
    await alertOwner(app, `setup:${c.id}`, SETUP.alert.sent(c.business), SETUP.alert.sentBody(local(c.assistant), page), 1);
    return { ok: true, how: open ? 'text' : 'template' };
  } catch (e) {
    app.log(`[setup] customer ${c.id}: not sent: ${e.code || ''} ${e.message}`);
    keep(app.db, c, { kind: 'setup', body, status: 'failed', error: e.message });
    await alertOwner(app, `setup:${c.id}`, SETUP.alert.failed(c.business), SETUP.alert.failedBody(codes.map(codeLine), page), 1);
    return { ok: false, why: 'failed', detail: e.message };
  }
}
