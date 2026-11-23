import { randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adminLink, alertOwner } from './alerts.js';
import { intakeTurn } from './claude.js';
import { DAY, HOUR, hhmm, israelDate, now, nowIso } from './clock.js';
import { ALERT, SVC, TRADE } from './copy.js';
import { num } from './env.js';
import { waHtml } from './html.js';
import { assistSettings, plainWords, sendText } from './meta.js';
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

// ---- a missed call and its summary, in their trade (the names, addresses and numbers are made up, and the phone
// says "דוגמה"; the business is theirs, and the city when we know it)

const EXAMPLES = {
  plumber: {
    city: 'חולון',
    said: (city) => `בוקר טוב, האסלה סתומה והמים עולים. סוקולוב 40 ${city}, אפשר עד הצהריים`,
    summary: (city) => ({ time: '08:12', what: 'האסלה סתומה, המים עולים', place: `סוקולוב 40, ${city}`, urgency: 'אפשר עד הצהריים', phone: '052-XXX-XX17' }),
  },
  electrician: {
    city: 'גבעתיים',
    said: (city) => `קפץ החשמל במטבח ובסלון ולא חוזר. ויצמן 8 ${city}, אני בבית עד הערב`,
    summary: (city) => ({ time: '17:26', what: 'אין חשמל במטבח ובסלון', place: `ויצמן 8, ${city}`, urgency: 'בבית עד הערב', phone: '050-XXX-XX64' }),
  },
  ac: {
    city: 'בת ים',
    said: (city) => `המזגן בסלון מטפטף מים. בן גוריון 22 ${city}, קומה 5. עדיף השבוע`,
    summary: (city) => ({ time: '13:05', what: 'מזגן בסלון מטפטף מים', place: `בן גוריון 22, ${city}`, urgency: 'לא דחוף, השבוע', phone: '054-XXX-XX90' }),
  },
  locksmith: {
    city: 'רמת גן',
    said: (city) => `ננעלתי בחוץ והמפתחות בפנים. הרא״ה 101 ${city}, מחכה למטה עם הילדים`,
    summary: (city) => ({ time: '21:48', what: 'נעול בחוץ, המפתחות בפנים', place: `הרא״ה 101, ${city}`, urgency: 'דחוף, מחכה בחוץ', phone: '053-XXX-XX05' }),
  },
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const wa = (digits, text) => `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
const plus = (hhmmText, n) => {
  const [h, m] = hhmmText.split(':').map(Number);
  const t = h * 60 + m + n;
  return `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};

// ---- the sample page, /p/demo: the same page for a made-up business in each trade (?trade=electrician), so anyone
// can see what a lead gets and try המוקדן from it. Its codes hold 0 and l, which a lead's code never does (ALPHABET),
// so they never meet one. A try from it has no lead (demos.sample holds the trade), never tells the owner, and has
// its own daily limit.

export const SAMPLE = {
  plumber: { name: 'אבי אינסטלציה', code: 'sample0plb' },
  electrician: { name: 'דני חשמל', code: 'sample0elc' },
  ac: { name: 'רועי מיזוג אוויר', code: 'sample0acc' },
  locksmith: { name: 'משה מנעולן', code: 'sample0lck' },
};
export const SAMPLE_PER_DAY = 20;

/** The made-up lead the sample page is for, in one trade (a plumber by default). */
export function sampleLead(trade) {
  const t = SAMPLE[trade] ? trade : 'plumber';
  return { id: null, name: SAMPLE[t].name, trade: t, city: '', page_code: SAMPLE[t].code, sample: t };
}

const sampleOf = (code) => Object.keys(SAMPLE).find((t) => SAMPLE[t].code === code) || null;

/**
 * The page, for one lead: a missed call and what they get from it, then two buttons. Few words: they read it on a job.
 * The sample page (lead.sample) also says it is one, and lets them switch trade. At the bottom, small, who writes to
 * them (SENDER_LINE), the owner, 2026-11-23: "it can be shown in a small line in the demo bottom".
 */
export function pageHtml(env, lead) {
  const biz = bizOf(lead);
  const ex = EXAMPLES[lead.trade] || EXAMPLES.plumber;
  const city = String(lead.city || '').trim() || ex.city;
  const sum = ex.summary(city);
  const assist = assistSettings(env).number;
  const tryLink = assist ? wa(assist, `אני רוצה לנסות (${lead.page_code})`) : '';
  const talkLink = salesNumber() ? wa(salesNumber(), `היי, ראיתי את הדף של ${biz}`) : '';
  const bubbles = [
    ['out', SVC.callerFirst(biz), plus(sum.time, 1)],
    ['in', ex.said(city), plus(sum.time, 2)],
    ['out', SVC.callerThanks(biz), plus(sum.time, 3)],
  ]
    .map(([dir, text, time]) => `<li class="${dir === 'in' ? 'o' : ''}">${waHtml(text).replace(/\n+/g, '<br>')}<time>${time}</time></li>`)
    .join('');
  const rows = [
    ['מה', sum.what],
    ['איפה', sum.place],
    ['כמה דחוף', sum.urgency],
    ['טלפון', sum.phone],
  ]
    .map(([k, v]) => `<div><dt>${k}</dt><dd${k === 'טלפון' ? ' dir="ltr"' : ''}>${esc(v)}</dd></div>`)
    .join('');
  const sender = String(env.SENDER_LINE || '').trim();
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
:root{--navy:#0B2340;--or:#FF6A13;--blue:#1F6FEB;--sky:#EEF2F7;--mute:#5d6e80}
*{box-sizing:border-box}
body{margin:0;background:#fff;color:var(--navy);font:400 1.0625rem/1.5 Heebo,system-ui,"Segoe UI",Arial,sans-serif;direction:rtl}
.wrap{max-width:30rem;margin:0 auto;padding:0 1rem}
h1,h2,p,dl,dd{margin:0}
:focus-visible{outline:3px solid var(--navy);outline-offset:3px}
.top{background:var(--navy);color:#fff;padding:1rem 0 1.75rem;text-align:center}
.top img{width:7.5rem;height:auto}
.for{margin-top:1.25rem;color:#ffb37f;font-weight:700;font-size:1rem}
h1{margin-top:.25rem;font-size:clamp(1.9rem,8.5vw,2.4rem);line-height:1.15;font-weight:900}
.sub{margin-top:.5rem;color:#d3dcea}
.phone{margin-top:1.25rem;overflow:hidden;border:6px solid #0b1522;border-radius:1.4rem;background:#efeae2}
.wa{display:flex;align-items:center;gap:.5rem;padding:.45rem .75rem;background:#008069;color:#fff;font-weight:700;font-size:.95rem}
.wa img{width:1.9rem;height:1.9rem;border-radius:50%}
.wa small{margin-inline-start:auto;font-weight:400;opacity:.8}
.chat{list-style:none;margin:0;padding:.6rem .55rem .8rem;display:flex;flex-direction:column;gap:.3rem}
.chat li{align-self:flex-start;max-width:85%;padding:.35rem .55rem .2rem;border-radius:.6rem;background:#fff;box-shadow:0 1px .5px #0b141a22;font-size:.95rem;line-height:1.4}
.chat .o{align-self:flex-end;background:#d9fdd3}
.chat time{display:block;text-align:end;color:#54656f;font-size:.7rem}
.arrow{margin:1.1rem 0 .5rem;font-weight:800;font-size:1.15rem}
.sum{padding:.9rem 1rem;border-radius:1rem;background:var(--sky)}
.sum div{display:flex;gap:.75rem;padding:.3rem 0}
.sum div+div{border-top:1px solid #d6dee9}
.sum dt{flex:0 0 4.5rem;color:var(--mute);font-size:.95rem}
.sum dd{font-weight:700}
.btn{display:flex;align-items:center;justify-content:center;gap:.55rem;min-height:3.5rem;margin-top:.75rem;padding:.75rem 1.25rem;border-radius:999px;background:var(--blue);color:#fff;font-weight:800;font-size:1.2rem;text-decoration:none}
.btn.or{background:var(--or);color:var(--navy)}
.btn svg{width:1.35rem;height:1.35rem;fill:none;stroke:currentColor;stroke-width:2.2;stroke-linejoin:round}
.cta{margin-top:1.75rem;text-align:center}
.cta h2{font-size:1.35rem;font-weight:900}
.cta p{margin-top:.15rem;color:var(--mute)}
.price{margin-top:1.75rem;padding:1.25rem 1rem;border-radius:1.25rem;background:var(--sky);text-align:center}
.price h2{font-size:1.6rem;font-weight:900}
.price p{color:var(--mute)}
footer{margin-top:2rem;padding:1.25rem 0 2rem;background:var(--navy);color:#a9b9cd;font-size:.85rem;text-align:center}
footer a{color:#fff}
footer .who{margin-top:.6rem;font-size:.75rem}
.sample{margin:1rem 0 0;padding:.55rem .8rem;border-radius:.8rem;background:#ffffff14;color:#d3dcea;font-size:.92rem}
.trades{display:flex;flex-wrap:wrap;justify-content:center;gap:.35rem;margin-top:.6rem}
.trades a{display:inline-flex;align-items:center;min-height:2.4rem;padding:.3rem .8rem;border-radius:999px;box-shadow:inset 0 0 0 2px #ffffff40;color:#fff;font-size:.9rem;font-weight:700;text-decoration:none}
.trades a[aria-current=page]{background:var(--or);box-shadow:none;color:var(--navy)}
</style>
</head>
<body>
<header class="top"><div class="wrap">
<img src="/svg/al-hakav-logo-on-dark.svg" alt="על הקו" width="120" height="28">
${lead.sample ? `<p class="sample">זה דף לדוגמה. ככה נראה הדף שאנחנו מכינים לכל בעל מקצוע, עם השם של העסק שלו</p><nav class="trades" aria-label="מקצוע">${Object.keys(SAMPLE).map((t) => `<a href="/p/demo${t === 'plumber' ? '' : `?trade=${t}`}"${t === lead.sample ? ' aria-current="page"' : ''}>${esc(TRADE[t])}</a>`).join('')}</nav>` : ''}
<p class="for">בשביל ${esc(biz)}</p>
<h1>ככה זה ייראה אצלכם</h1>
<p class="sub">כשאתם לא עונים, מי שהתקשר מקבל מהמוקדן הודעה בוואטסאפ, ואליכם מגיע סיכום של מה שהוא צריך</p>
</div></header>
<main class="wrap">
<div class="phone" role="img" aria-label="דוגמה לשיחה בוואטסאפ בין המוקדן למי שהתקשר"><p class="wa"><img src="/svg/al-hakav-mokdan-avatar.svg" alt="" width="30" height="30">המוקדן של על הקו<small>דוגמה</small></p><ol class="chat">${bubbles}</ol></div>
<p class="arrow">ומה שמגיע אליכם</p>
<dl class="sum">${rows}</dl>
${tryLink ? `<div class="cta"><h2>לנסות על עצמכם</h2><p>המוקדן כותב לכם כאילו התקשרתם לעסק, ובסוף מגיע הסיכום. לוקח דקה</p><a class="btn" href="${esc(tryLink)}">${icon}לנסות בוואטסאפ</a></div>` : ''}
<div class="price"><h2>149 ₪ לחודש</h2><p>לא כולל מע״מ, ואין דמי הקמה</p>${talkLink ? `<a class="btn or" href="${esc(talkLink)}">${icon}רוצים את זה? כתבו לנו</a>` : ''}</div>
</main>
<footer><div class="wrap"><a href="/">על הקו</a> · <a href="/terms">תנאים</a> · <a href="/privacy">פרטיות</a> · <a href="/accessibility">נגישות</a>${sender ? `<p class="who">${esc(sender)}</p>` : ''}</div></footer>
</body>
</html>`;
}

/** A view of a lead's page: counted, and the admin told the first time in a day. */
export async function pageViewed(app, lead) {
  const at = nowIso();
  app.db.run('UPDATE leads SET page_views = page_views + 1, page_first_at = COALESCE(page_first_at, ?), page_last_at = ? WHERE id = ?', at, at, lead.id);
  await alertOwner(app, `page:${lead.id}`, ALERT.page(bizOf(lead)), ALERT.body.open(adminLink(app.env, `/admin/leads/${lead.id}`)), 24 * 60);
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
  const lead = code && (sampleOf(code) ? sampleLead(sampleOf(code)) : leadByCode(db, code));
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
  const perPage = lead.sample
    ? db.get('SELECT count(*) AS n FROM demos WHERE lead_id IS NULL AND started_at > ?', nowIso(now() - DAY)).n
    : db.get('SELECT count(*) AS n FROM demos WHERE lead_id = ? AND started_at > ?', lead.id, nowIso(now() - DAY)).n;
  const all = db.get('SELECT count(*) AS n FROM demos WHERE started_at > ?', nowIso(now() - DAY)).n;
  if (perPage >= (lead.sample ? SAMPLE_PER_DAY : DEMO_PER_PAGE) || all >= s.daily) {
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
  const id = Number(db.run('INSERT INTO demos (lead_id, sample, phone, started_at, updated_at) VALUES (?, ?, ?, ?, ?)', lead.id, lead.sample || null, phone, nowIso(), nowIso()).lastInsertRowid);
  keep(db, id, 'in', 'start', String(m.text || ''), m.id || null);
  await say(app, id, phone, 'intro', DEMO.intro(biz));
  await say(app, id, phone, 'first', SVC.callerFirst(biz));
  app.log(`[demo] ${masked(phone)} started a try of ${lead.sample ? `the sample page (${lead.sample})` : `lead ${lead.id}`}`);
  if (!lead.sample) await alertOwner(app, `demo:${lead.id}`, ALERT.tried(biz), ALERT.body.open(adminLink(app.env, `/admin/leads/${lead.id}`)), 24 * 60);
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
    const lead = d.lead_id ? db.get('SELECT * FROM leads WHERE id = ?', d.lead_id) : d.sample ? sampleLead(d.sample) : null;
    if (!lead) return;
    const biz = bizOf(lead);
    const messages = db.all("SELECT dir, body FROM demo_messages WHERE demo_id = ? AND kind IN ('first', 'in', 'reply') ORDER BY at, id", d.id);
    let next = null;
    if (d.turns < DEMO_TURNS && app.claude) {
      try {
        next = await intakeTurn(app.claude, { business: biz, trade: lead.trade }, messages);
        if (next.cut?.length) app.log(`[demo] ${d.id}: the guard cut ${next.cut.join(', ')} from: ${String(next.raw).slice(0, 200)}`);
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
    const summary = SVC.summary({ time: hhmm(Date.parse(fin.started_at)), what: plainWords(fin.what) || SVC.unknown, place: plainWords(fin.place) || SVC.unknown, urgency: plainWords(fin.urgency) || SVC.unknown, phone: local(fin.phone) });
    await say(app, d.id, d.phone, 'summary', `${DEMO.summaryLead}\n\n${summary}`);
    await say(app, d.id, d.phone, 'closing', DEMO.closing(biz, salesNumber()));
  } finally {
    busy.delete(key);
  }
}

/** What המוקדן says around a try, in plain words (copy.js's voice). */
export const DEMO = {
  intro: (biz) => `👋 היי, כאן המוקדן של *על הקו*. עכשיו אתם הלקוח: נגיד שהתקשרתם ל${biz} ולא ענו. זו ההודעה שמי שמתקשר אליכם מקבל, ואפשר לענות לי כמו לקוח.`,
  summaryLead: '👇 וזה מה שהיה מגיע אליכם לוואטסאפ:',
  closing: (biz, salesDigits) => `✅ ככה זה עובד אצל ${biz}, על כל שיחה שלא עניתם. *רוצים את זה על המספר שלכם?*${salesDigits ? ` כתבו לנו כאן: https://wa.me/${salesDigits}` : ''}`,
  full: (salesDigits) => `⏳ הרבה מנסים היום, אז הניסיון לא נפתח עכשיו. אפשר לנסות שוב מחר מהדף${salesDigits ? `, או לכתוב לנו: https://wa.me/${salesDigits}` : '.'}`,
};
