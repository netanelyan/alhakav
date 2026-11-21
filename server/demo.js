import { randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adminLink, alertOwner } from './alerts.js';
import { intakeTurn } from './claude.js';
import { DAY, HOUR, hhmm, israelDate, now, nowIso } from './clock.js';
import { SVC } from './copy.js';
import { num } from './env.js';
import { assistSettings, sendText } from './meta.js';
import { local, masked } from './phones.js';

// Each lead's own page, and the try of המוקדן on it (docs/demo.md), the way openfrequency-toran builds each store a
// pitch page with a working demo. Small, and for one business: their name, a missed call and its summary from their
// own trade (and their city when we know it), the price, and two buttons.
//
//   /p/<code>      the page, with an unguessable code of 10 letters and digits; not indexed; each view is counted, and
//                  the admin is told the first time in a day
//   the try        "לנסות בוואטסאפ" opens a WhatsApp message to המוקדן with the page's code in it. המוקדן then plays it
//                  for real: they are the customer who called the business, it asks what Claude asks every caller, and
//                  at the end the summary goes to them, the one their business would get
//   limits         a try ends after 12 of their messages or 2 quiet hours; at most 5 tries a day for one page, and
//                  DEMO_DAILY (30) a day over all of them, so the try never runs up the Claude bill
//
// The message after "כן, שלחו" (copy.js MSG.pitch) sends the page. Nothing here throws to the webhook.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CODE = /^[a-z0-9]{10}$/;
const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
export const DEMO_TURNS = 12;
export const DEMO_IDLE = 2 * HOUR;
export const DEMO_PER_PAGE = 5;

/** The business number's digits, as the site's WhatsApp buttons have them. */
let sales = null;
const salesNumber = () => (sales ??= (/wa\.me\/(\d{11,15})/.exec(readFileSync(path.join(ROOT, 'index.html'), 'utf8')) || [])[1] || '');

const site = (env) => String(env.SITE_URL || '').replace(/\/+$/, '');
export const pageUrl = (env, code) => `${site(env)}/p/${code}`;
export const bizOf = (lead) => String(lead.msg_name || lead.name || '').trim() || 'העסק שלכם';

/** The lead's page code, made the first time it is needed. */
export function pageCodeOf(db, lead) {
  if (lead.page_code) return lead.page_code;
  for (;;) {
    const code = Array.from({ length: 10 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
    if (db.get('SELECT 1 FROM leads WHERE page_code = ?', code)) continue;
    db.run('UPDATE leads SET page_code = ? WHERE id = ? AND page_code IS NULL', code, lead.id);
    const kept = db.get('SELECT page_code FROM leads WHERE id = ?', lead.id)?.page_code;
    lead.page_code = kept;
    return kept;
  }
}

export const leadByCode = (db, code) => (CODE.test(String(code)) ? db.get('SELECT * FROM leads WHERE page_code = ?', code) : null);

// ---- a missed call and its summary, in their trade (the names, addresses and numbers are made up; the business is
// theirs, and the city when we know it)

const EXAMPLES = {
  plumber: {
    city: 'חולון',
    chat: (biz, city) => [
      ['in', 'בוקר טוב, האסלה סתומה והמים עולים כשמורידים', '08:13'],
      ['out', 'יש בבית עוד שירותים שעובדים? ומה הכתובת?', '08:14'],
      ['in', `יש עוד אחד והוא בסדר. סוקולוב 40 ${city}, דירה 12. אפשר גם בצהריים, לא חייב עכשיו`, '08:15'],
      ['out', `תודה, הפרטים אצל ${biz} והם יחזרו אליך כשיתפנו.`, '08:15'],
    ],
    summary: (city) => ({ time: '08:12', what: 'סתימה באסלה, המים עולים כשמורידים. יש בבית עוד שירותים תקינים', place: `סוקולוב 40, ${city}. דירה 12`, urgency: 'בינונית, אפשר עד הצהריים', phone: '052-XXX-XX17' }),
  },
  electrician: {
    city: 'גבעתיים',
    chat: (biz, city) => [
      ['in', 'קפץ החשמל במטבח ובסלון ואני לא מצליחה להחזיר אותו', '17:27'],
      ['out', 'יש ריח של שרוף, או שקע או מפסק שמרגישים חמים? ומה הכתובת?', '17:28'],
      ['in', `אין שום ריח. ויצמן 8 ${city}, אני בבית עד הערב`, '17:29'],
      ['out', `תודה, הפרטים אצל ${biz} והם יחזרו אליך כשיתפנו.`, '17:29'],
    ],
    summary: (city) => ({ time: '17:26', what: 'אין חשמל במטבח ובסלון, המפסק לא חוזר. אין ריח שרוף', place: `ויצמן 8, ${city}`, urgency: 'הלקוחה בבית עד הערב', phone: '050-XXX-XX64' }),
  },
  ac: {
    city: 'בת ים',
    chat: (biz, city) => [
      ['in', 'המזגן בסלון מטפטף מים על הרצפה', '13:06'],
      ['out', 'איזה מזגן זה, ובן כמה בערך? ומה הכתובת?', '13:07'],
      ['in', `עילי, בן 6 בערך. בן גוריון 22 ${city}, קומה 5. כיביתי אותו בינתיים, עדיף השבוע`, '13:08'],
      ['out', `תודה, הפרטים אצל ${biz} והם יחזרו אליך כשיתפנו.`, '13:09'],
    ],
    summary: (city) => ({ time: '13:05', what: 'מזגן עילי בסלון מטפטף מים, בן 6 בערך. כרגע כבוי', place: `בן גוריון 22, ${city}. קומה 5`, urgency: 'לא דחוף, ביקש השבוע', phone: '054-XXX-XX90' }),
  },
  locksmith: {
    city: 'רמת גן',
    chat: (biz, city) => [
      ['in', 'ננעלתי מחוץ לבית והמפתחות בפנים', '21:49'],
      ['out', 'אוי. איזו דלת, רגילה או דלת ביטחון? ומה הכתובת?', '21:50'],
      ['in', `דלת ביטחון. הרא״ה 101 ${city}, אני מחכה למטה עם הילדים`, '21:50'],
      ['out', `העברתי ל${biz} שזה דחוף. הם יתקשרו אליך ברגע שיתפנו.`, '21:51'],
    ],
    summary: (city) => ({ time: '21:48', what: 'ננעלה מחוץ לבית, המפתחות בפנים. דלת ביטחון', place: `הרא״ה 101, ${city}`, urgency: 'דחוף, מחכה בחוץ עם ילדים', phone: '053-XXX-XX05' }),
  },
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const wa = (digits, text) => `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;

/** The page, for one lead. */
export function pageHtml(env, lead) {
  const biz = bizOf(lead);
  const ex = EXAMPLES[lead.trade] || EXAMPLES.plumber;
  const city = String(lead.city || '').trim() || ex.city;
  const chat = ex.chat(biz, city);
  const sum = ex.summary(city);
  const assist = assistSettings(env).number;
  const tryLink = assist ? wa(assist, `אני רוצה לנסות (${lead.page_code})`) : '';
  const talkLink = salesNumber() ? wa(salesNumber(), `היי, ראיתי את הדף של ${biz}`) : '';
  const bubbles = [['out', SVC.callerFirst(biz), chat[0][2]], ...chat]
    .map(([dir, text, time]) => `<li class="${dir === 'in' ? 'o' : ''}">${esc(text).replace(/\n/g, '<br>')}<time>${esc(time)}</time></li>`)
    .join('');
  // The number reads left to right inside the Hebrew.
  const summary = esc(SVC.summary({ ...sum, phone: '@@PHONE@@' }))
    .replace(/\n/g, '<br>')
    .replace('@@PHONE@@', `<bdi dir="ltr">${esc(sum.phone)}</bdi>`);
  const icon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20l1.3-3.9A8 8 0 1 1 8 18.8L4 20z"/></svg>';
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(biz)} | על הקו</title>
<meta name="theme-color" content="#0B2340">
<link rel="icon" href="/svg/al-hakav-favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Heebo:wght@400;700;800;900&amp;display=swap">
<style>
:root{--navy:#0B2340;--or:#FF6A13;--blue:#1F6FEB;--sky:#EEF2F7;--txt:#33475e;--mute:#5d6e80}
*{box-sizing:border-box}
body{margin:0;background:#fff;color:var(--navy);font:400 1.125rem/1.55 Heebo,system-ui,"Segoe UI",Arial,sans-serif;direction:rtl}
.wrap{max-width:34rem;margin:0 auto;padding:0 1.25rem}
h1,h2,p{margin:0}
h1,h2{line-height:1.15;font-weight:900}
:focus-visible{outline:3px solid var(--navy);outline-offset:3px}
.top{background:var(--navy);color:#fff;padding:1rem 0 2.25rem}
.top img{display:block;width:8.5rem;height:auto}
.for{margin-top:1.5rem;color:#ffb37f;font-weight:700}
h1{margin-top:.4rem;font-size:clamp(2rem,8vw,2.6rem)}
.lead{margin-top:.75rem;color:#d3dcea}
.try{margin:-1.25rem auto 0;padding:1.25rem;border-radius:1.25rem;background:#fff;box-shadow:0 10px 30px #0b234026;position:relative}
.try h2{font-size:1.45rem;display:flex;align-items:center;gap:.6rem}
.try h2 img{width:2.4rem;height:2.4rem;border-radius:50%}
.try p{margin-top:.5rem;color:var(--txt)}
.btn{display:flex;align-items:center;justify-content:center;gap:.6rem;min-height:3.6rem;margin-top:1rem;padding:.8rem 1.25rem;border-radius:999px;background:var(--blue);color:#fff;font-weight:800;font-size:1.25rem;text-decoration:none}
.btn.or{background:var(--or);color:var(--navy)}
.btn svg{width:1.4rem;height:1.4rem;fill:none;stroke:currentColor;stroke-width:2.2;stroke-linejoin:round}
section{padding:2.25rem 0 0}
h2{font-size:1.5rem}
.cap{margin:.9rem 0 .5rem;color:var(--mute);font-size:.95rem}
.phone{overflow:hidden;border:7px solid #0b1522;border-radius:1.5rem;background:#efeae2}
.wa{display:flex;align-items:center;gap:.6rem;padding:.5rem .8rem;background:#008069;color:#fff;font-weight:700}
.wa img{width:2.1rem;height:2.1rem;border-radius:50%}
.chat{list-style:none;margin:0;padding:.7rem .6rem 1rem;display:flex;flex-direction:column;gap:.3rem}
.chat li{align-self:flex-start;max-width:86%;padding:.35rem .55rem .2rem;border-radius:.6rem;background:#fff;box-shadow:0 1px .5px #0b141a22;font-size:1rem;line-height:1.4}
.chat .o{align-self:flex-end;background:#d9fdd3}
.chat time{display:block;text-align:end;color:#54656f;font-size:.72rem}
.sum{padding:1rem;border-radius:1rem;background:var(--sky);font-size:1rem;line-height:1.5}
.price{margin-top:2.25rem;padding:1.5rem 1.25rem;border-radius:1.25rem;background:var(--sky)}
.price p{margin-top:.5rem;color:var(--txt)}
.fine{margin-top:1.5rem;color:var(--mute);font-size:.85rem}
footer{margin-top:2.5rem;padding:1.5rem 0 2.5rem;background:var(--navy);color:#a9b9cd;font-size:.95rem}
footer a{color:#fff}
</style>
</head>
<body>
<header class="top"><div class="wrap">
<img src="/svg/al-hakav-logo-on-dark.svg" alt="על הקו" width="136" height="32">
<p class="for">הכנו את הדף הזה בשביל ${esc(biz)}</p>
<h1>ככה זה ייראה אצלכם</h1>
<p class="lead">כשאתם באמצע עבודה ולא עונים, מי שהתקשר מקבל מהמוקדן שלנו הודעה בוואטסאפ, בשם ${esc(biz)}. אתם מקבלים מה הוא צריך, וחוזרים אליו כשמתפנים.</p>
</div></header>
<main class="wrap">
${tryLink ? `<div class="try">
<h2><img src="/svg/al-hakav-mokdan-avatar.svg" alt="" width="38" height="38">לנסות על עצמכם, בדקה</h2>
<p>לוחצים, ושולחים את ההודעה שנפתחת. המוקדן יכתוב לכם כאילו התקשרתם ל${esc(biz)} ולא ענו. עונים לו כמו לקוח, ובסוף מקבלים את הסיכום שהיה מגיע אליכם.</p>
<a class="btn" href="${esc(tryLink)}">${icon}לנסות בוואטסאפ</a>
</div>` : ''}
<section aria-labelledby="ex">
<h2 id="ex">מישהו התקשר ל${esc(biz)} ולא עניתם</h2>
<p class="cap">ככה זה נראה אצלו</p>
<div class="phone"><p class="wa"><img src="/svg/al-hakav-mokdan-avatar.svg" alt="" width="34" height="34">המוקדן של על הקו</p><ol class="chat">${bubbles}</ol></div>
<p class="cap">וזה מה שמגיע אליכם לוואטסאפ</p>
<p class="sum">${summary}</p>
</section>
<div class="price">
<h2>149 ₪ לחודש</h2>
<p>לא כולל מע״מ. אין דמי הקמה. המספר שלכם נשאר כמו שהוא. משלמים חודש מראש, ומי שרוצה להפסיק מפסיק לפני החודש הבא.</p>
${talkLink ? `<a class="btn or" href="${esc(talkLink)}">${icon}רוצים את זה? כתבו לנו</a>` : ''}
</div>
<p class="fine">השמות, הכתובות והמספרים בדוגמה מומצאים, חוץ מהשם שלכם.</p>
</main>
<footer><div class="wrap"><p><a href="/">על הקו</a> · <a href="/terms">תנאי שימוש</a> · <a href="/privacy">מדיניות פרטיות</a> · <a href="/accessibility">הצהרת נגישות</a></p></div></footer>
</body>
</html>`;
}

/** A view of a lead's page: counted, and the admin told the first time in a day. */
export async function pageViewed(app, lead) {
  const at = nowIso();
  app.db.run('UPDATE leads SET page_views = page_views + 1, page_first_at = COALESCE(page_first_at, ?), page_last_at = ? WHERE id = ?', at, at, lead.id);
  await alertOwner(app, `page:${lead.id}`, `על הקו: ${bizOf(lead)} פתחו את הדף שלהם`, `הדף: ${pageUrl(app.env, lead.page_code)}\nהליד: ${adminLink(app.env, `/admin/leads/${lead.id}`)}`, 24 * 60);
}

// ---- the try, on המוקדן's number

const settings = (env) => ({ daily: num(env.DEMO_DAILY, 30), delay: num(env.REPLY_DELAY_MS, 3000) });
const demoOf = (db, id) => db.get('SELECT * FROM demos WHERE id = ?', id);

function keep(db, demoId, dir, kind, body, msgId = null) {
  return db.run('INSERT OR IGNORE INTO demo_messages (demo_id, dir, kind, body, msg_id, at) VALUES (?, ?, ?, ?, ?, ?)', demoId, dir, kind, body, msgId, nowIso()).changes > 0;
}

async function say(app, demoId, phone, kind, body) {
  try {
    const id = await sendText(assistSettings(app.env), app.graphFetch, phone, body);
    keep(app.db, demoId, 'out', kind, body, id || null);
  } catch (e) {
    app.log(`[demo] ${kind} to ${masked(phone)} not sent: ${e.message}`);
  }
}

/** The page code in a message, as the page's button writes it: "אני רוצה לנסות (abcdefgh23)". */
export const codeIn = (text) => (/\(([a-z0-9]{10})\)/.exec(String(text || '')) || /(?:^|\s)([a-z0-9]{10})(?:\s|$)/.exec(String(text || '')) || [])[1] || null;

/**
 * A message to המוקדן that belongs to a try: one with a page's code starts one, and while a try is open (2 quiet hours
 * at most) the same phone's messages are its turns. Answers true when it was a try's.
 */
export async function demoMessage(app, phone, m) {
  const { db } = app;
  const text = String(m.text || '').trim();
  const code = codeIn(text);
  const lead = code && leadByCode(db, code);
  if (lead) {
    await startDemo(app, lead, phone, m);
    return true;
  }
  const open = db.get("SELECT * FROM demos WHERE phone = ? AND state = 'talking' AND updated_at > ? ORDER BY id DESC LIMIT 1", phone, nowIso(now() - DEMO_IDLE));
  if (!open) return false;
  if (!keep(db, open.id, 'in', 'in', text, m.id || null)) return true; // seen before
  db.run('UPDATE demos SET turns = turns + 1, updated_at = ? WHERE id = ?', nowIso(), open.id);
  schedule(app, open.id);
  return true;
}

async function startDemo(app, lead, phone, m) {
  const { db } = app;
  const s = settings(app.env);
  const biz = bizOf(lead);
  const today = `${israelDate()}T00:00`;
  db.run("DELETE FROM demos WHERE started_at < ?", nowIso(now() - 30 * DAY));
  if (m.id && db.get('SELECT 1 FROM demo_messages WHERE msg_id = ?', m.id)) return; // the same webhook again
  const perPage = db.get('SELECT count(*) AS n FROM demos WHERE lead_id = ? AND started_at > ?', lead.id, nowIso(now() - DAY)).n;
  const all = db.get('SELECT count(*) AS n FROM demos WHERE started_at > ?', nowIso(now() - DAY)).n;
  if (perPage >= DEMO_PER_PAGE || all >= s.daily) {
    app.log(`[demo] ${masked(phone)} asked for a try of lead ${lead.id}: over the day's limit (${today})`);
    try {
      await sendText(assistSettings(app.env), app.graphFetch, phone, DEMO.full(salesNumber()));
    } catch (e) {
      app.log(`[demo] limit line to ${masked(phone)} not sent: ${e.message}`);
    }
    return;
  }
  // A new try closes the one before on this phone.
  db.run("UPDATE demos SET state = 'done', updated_at = ? WHERE phone = ? AND state = 'talking'", nowIso(), phone);
  const id = Number(db.run('INSERT INTO demos (lead_id, phone, started_at, updated_at) VALUES (?, ?, ?, ?)', lead.id, phone, nowIso(), nowIso()).lastInsertRowid);
  keep(db, id, 'in', 'start', String(m.text || ''), m.id || null);
  await say(app, id, phone, 'intro', DEMO.intro(biz));
  await say(app, id, phone, 'first', SVC.callerFirst(biz));
  app.log(`[demo] ${masked(phone)} started a try of lead ${lead.id}`);
  await alertOwner(app, `demo:${lead.id}`, `על הקו: ${biz} מנסים את המוקדן על עצמם`, `הליד: ${adminLink(app.env, `/admin/leads/${lead.id}`)}`, 24 * 60);
}

/** Answer a try a moment after its last message, one turn at a time (the same way service.js answers a caller). */
function schedule(app, demoId) {
  const s = app.service;
  const key = `demo:${demoId}`;
  const old = s.timers.get(key);
  if (old) {
    clearTimeout(old.timer);
    old.resolve();
  }
  let resolve;
  const done = new Promise((r) => (resolve = r));
  const fire = () => {
    clearTimeout(entry.timer);
    s.timers.delete(key);
    const p = turn(app, demoId).catch((e) => app.log(`[demo] ${e.stack || e}`));
    s.pending.add(p);
    p.finally(() => {
      s.pending.delete(p);
      resolve();
    });
  };
  const entry = { timer: setTimeout(fire, settings(app.env).delay), resolve, fire };
  s.timers.set(key, entry);
  s.pending.add(done);
  done.finally(() => s.pending.delete(done));
}

async function turn(app, demoId) {
  const { db } = app;
  const busy = app.service.busy;
  const key = `demo:${demoId}`;
  if (busy.has(key)) return;
  busy.add(key);
  try {
    const d = demoOf(db, demoId);
    if (!d || d.state !== 'talking') return;
    const lead = db.get('SELECT * FROM leads WHERE id = ?', d.lead_id);
    if (!lead) return;
    const biz = bizOf(lead);
    const messages = db.all("SELECT dir, body FROM demo_messages WHERE demo_id = ? AND kind IN ('first', 'in', 'reply') ORDER BY at, id", d.id);
    let next = null;
    if (d.turns < DEMO_TURNS && app.claude) {
      try {
        next = await intakeTurn(app.claude, { business: biz, trade: lead.trade }, messages);
      } catch (e) {
        app.log(`[demo] ${d.id}: Claude: ${e.message}`);
      }
    }
    if (!next) {
      const said = messages.filter((x) => x.dir === 'in').map((x) => x.body).join(' / ');
      next = { reply: SVC.callerThanks(biz), done: true, what: d.what || said.slice(0, 300), place: d.place, urgency: d.urgency };
    }
    await say(app, d.id, d.phone, 'reply', next.reply);
    db.run('UPDATE demos SET what = ?, place = ?, urgency = ?, updated_at = ? WHERE id = ?', next.what || d.what, next.place || d.place, next.urgency || d.urgency, nowIso(), d.id);
    if (!next.done) return;
    const fin = demoOf(db, d.id);
    db.run("UPDATE demos SET state = 'done', updated_at = ? WHERE id = ?", nowIso(), d.id);
    const summary = SVC.summary({ time: hhmm(Date.parse(fin.started_at)), what: fin.what || SVC.unknown, place: fin.place || SVC.unknown, urgency: fin.urgency || SVC.unknown, phone: local(fin.phone) });
    await say(app, d.id, d.phone, 'summary', `${DEMO.summaryLead}\n\n${summary}`);
    await say(app, d.id, d.phone, 'closing', DEMO.closing(biz, salesNumber()));
  } finally {
    busy.delete(key);
  }
}

/** What המוקדן says around a try, in plain words (copy.js's voice). */
export const DEMO = {
  intro: (biz) => `היי, כאן המוקדן של על הקו. עכשיו אתם הלקוח: נגיד שהתקשרתם ל${biz} ולא ענו. זו ההודעה שמי שמתקשר אליכם מקבל, ואפשר לענות לי כמו לקוח.`,
  summaryLead: 'וזה מה שהיה מגיע אליכם לוואטסאפ:',
  closing: (biz, salesDigits) => `ככה זה עובד אצל ${biz}, על כל שיחה שלא עניתם. רוצים את זה על המספר שלכם?${salesDigits ? ` כתבו לנו כאן: https://wa.me/${salesDigits}` : ''}`,
  full: (salesDigits) => `הרבה מנסים היום, אז הניסיון לא נפתח עכשיו. אפשר לנסות שוב מחר מהדף${salesDigits ? `, או לכתוב לנו: https://wa.me/${salesDigits}` : '.'}`,
};
