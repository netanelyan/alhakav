import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRICE, VAT, money } from './billing.js';

// What Toran knows about על הקו (docs/toran.md): one JSON file in openfrequency-toran's company export format (its
// src/company.ts readExport), made from this repository's own pages, so the agent says what the site says. Its parts:
//
//   status   what works today and what not yet, which the agent puts above everything else
//   start    how someone starts: "join", so Toran asks for the business name and hands them to us, and this server
//            sends the amount and the transfer details (toran.js)
//   plans    the one plan, with its price before and after VAT
//   faq      the site's questions, and a few more that come up in the chat (paying, what happens after)
//   pages    how it works, and the terms, the privacy policy and the accessibility statement
//
// `node server/main.js support <file>` writes it; then openfrequency-toran syncs it (`scripts/company.ts sync <file>`).
// Change a fact here or on a page, and write and sync it again.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const page = (name) => readFileSync(path.join(ROOT, name), 'utf8');

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** A page's HTML as plain text: one line for each paragraph, heading or list item. */
export function textOf(html) {
  return String(html)
    .replace(/<(script|style|svg|figure)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|h[1-6]|summary|details|div|section|ol|ul|tr)>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<\/(b|span|em|small|strong)>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|[a-z]+);/gi, (m, e) => (e[0] === '#' ? String.fromCharCode(Number(e.slice(1))) : (ENTITIES[e.toLowerCase()] ?? m)))
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').replace(/ ([.,:;?)])/g, '$1').trim())
    .filter(Boolean)
    .join('\n');
}

const mainOf = (html) => (/<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html) || [, html])[1];
const titleOf = (html) => textOf((/<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html) || [, ''])[1]);

/** The questions on the landing page, as they are written there. */
export function faqOf(html) {
  return [...String(html).matchAll(/<details>\s*<summary>([\s\S]*?)<\/summary>\s*<p>([\s\S]*?)<\/p>\s*<\/details>/gi)].map((m) => ({ q: textOf(m[1]), a: textOf(m[2]) }));
}

const withVat = money(Math.round(PRICE * (1 + VAT) * 100) / 100);

// What works today, said plainly. The agent never says something on the "not yet" list works.
const STATUS = [
  'מה עובד היום:',
  `- על הקו עולה ${PRICE} ₪ לחודש, לא כולל מע״מ (${withVat} ₪ כולל מע״מ). אין דמי הקמה, ומשלמים חודש מראש בהעברה בנקאית.`,
  '- מצטרפים כאן בוואטסאפ: אומרים לנו את שם העסק, מקבלים את הסכום ואת פרטי ההעברה, ואחרי ההעברה שולחים כאן צילום מסך או PDF של האישור.',
  '- תוך 24 שעות מהרגע שהתשלום הגיע שולחים לכם כאן את המספר שאליו יעברו השיחות שלא עניתם, ושלושה קודים להקליד בחייגן פעם אחת. אחר כך מבקשים ממישהו להתקשר ולא עונים, ורואים שזה עובד.',
  '- מי שהתקשר ולא עניתם לו מקבל בוואטסאפ הודעה מהמוקדן, המספר של על הקו, בשם העסק שלכם, מיד כשהשיחה נגמרת. המוקדן שואל מה קרה, איפה וכמה דחוף, ושולח לכם לוואטסאפ סיכום עם המספר שלו.',
  '- המוקדן עובד בכל שעה, גם בלילה ובשבת, ועונה למי שכותב ברוסית, בערבית או באנגלית בשפה שלו. הסיכום אליכם תמיד בעברית.',
  '- כותבים למוקדן "לא לשלוח" ומספר, והוא לא כותב למספר הזה. "לעצור" עוצר אותו לגמרי עד שכותבים "להמשיך".',
  '',
  'מה עוד לא:',
  '- אין הרשמה באתר. מצטרפים רק כאן בוואטסאפ.',
  '- אי אפשר לשלם בכרטיס אשראי. רק בהעברה בנקאית.',
].join('\n');

const START = 'מצטרפים כאן בוואטסאפ: אומרים לנו את שם העסק כמו שמי שמתקשר צריך לראות אותו, ומקבלים מיד את הסכום ואת פרטי ההעברה. אחרי ההעברה שולחים כאן צילום של האישור, ותוך 24 שעות מהרגע שהתשלום הגיע העוזר שלכם מוכן.';

// Questions that come up in the chat and are not on the landing page.
const MORE = [
  { q: 'כמה זה עולה?', a: `${PRICE} ₪ לחודש, לא כולל מע״מ, כלומר ${withVat} ₪ כולל מע״מ. זה כולל את מספר העוזר ואת ההודעות בוואטסאפ. אין דמי הקמה.` },
  { q: 'איך משלמים?', a: 'בהעברה בנקאית, חודש מראש. את הסכום ואת פרטי החשבון שולחים לכם כאן בוואטסאפ. אחרי ההעברה שולחים כאן צילום מסך או PDF של האישור, ואחרי שבדקנו מול הבנק מגיעה חשבונית מס קבלה.' },
  { q: 'אפשר לשלם בכרטיס אשראי?', a: 'עוד לא. כרגע משלמים רק בהעברה בנקאית.' },
  { q: 'מה קורה אחרי שמשלמים?', a: 'תוך 24 שעות מהרגע שהתשלום הגיע שולחים לכם כאן את המספר שאליו יעברו השיחות שלא עניתם, ושלושה קודים להקליד בחייגן פעם אחת. אחר כך מבקשים ממישהו להתקשר אליכם ולא עונים, ותוך כמה שניות מגיעה אליו הודעה מהמוקדן. משם המוקדן כותב לכל מי שהתקשר ולא עניתם, ושולח לכם סיכום.' },
  { q: 'איך אתם יודעים מה דחוף?', a: 'שואלים את מי שהתקשר. בנזילה, למשל, שואלים אם זה מטפטף או זורם. בסיכום רואים מה הוא ענה, ואתם מחליטים למי לחזור קודם.' },
  { q: 'מי עונה למי שמתקשר אליי, בן אדם?', a: 'המוקדן, מערכת AI שלנו, בשם העסק שלכם. הוא שואל מה קרה, איפה, וכמה זה דחוף, ושולח לכם לוואטסאפ מה הוא צריך. על מחיר ועל שעה הוא לא מתחייב. אם שואלים אותו, הוא אומר שהוא העוזר האוטומטי של העסק ושמישהו מהעסק יחזור.' },
  { q: 'ואם אחרי חודש אני רואה שזה לא שווה לי?', a: 'מפסיקים. משלמים חודש בחודש, ומי שרוצה להפסיק כותב לנו לפני החודש הבא. על חודש ששולם לא מחזירים כסף.' },
  // What a tradesperson asks before they join, and what they hold against it. Every answer is how the service works
  // today (service.js, claude.js, setup.js); nothing here promises work or income (Toran's own rule).
  { q: 'למה אני צריך את זה? מה זה נותן לי?', a: 'כשאתם באמצע עבודה ולא עונים, מי שהתקשר לא נשאר בלי תשובה: תוך כמה שניות הוא מקבל הודעה בוואטסאפ בשם העסק שלכם, שראו שהתקשר ושיחזרו אליו. אתם מקבלים סיכום של מה הוא צריך, איפה וכמה דחוף, וחוזרים אליו כשמתפנים, כבר יודעים במה מדובר.' },
  { q: 'מה שומע מי שמתקשר אליי כשאני לא עונה?', a: 'אחרי 20 שניות בלי מענה השיחה נגמרת, ותוך כמה שניות מגיעה אליו הודעה בוואטסאפ מהמוקדן: "שלום, כאן העוזר של" ושם העסק שלכם, שראו שהתקשר, ושאלה מה קרה ואיפה.' },
  { q: 'מה אם אני כן עונה לשיחה?', a: 'אז שום דבר לא משתנה. רק שיחה שלא עניתם עליה תוך 20 שניות, שהגיעה כשאתם באמצע שיחה אחרת, או כשהטלפון כבוי או בלי קליטה, עוברת למוקדן.' },
  { q: 'צריך להוריד אפליקציה?', a: 'לא. הכול בוואטסאפ ובטלפון שיש לכם. מקלידים בחייגן שלושה קודים פעם אחת, והסיכומים מגיעים אליכם לוואטסאפ.' },
  { q: 'זה עובד באייפון ובאנדרואיד?', a: 'כן, בכל טלפון נייד. את הקודים מקלידים בחייגן ולוחצים חיוג, כמו מספר רגיל.' },
  { q: 'המוקדן עובד גם בלילה ובשבת?', a: 'כן, בכל שעה, גם בלילה, בשבת ובחגים. כל שיחה שלא עניתם מקבלת הודעה, ואתם מחליטים מתי לחזור.' },
  { q: 'מה אם מי שמתקשר מדבר רוסית או ערבית?', a: 'המוקדן עונה לו בשפה שבה הוא כותב, רוסית, ערבית, אנגלית או אחרת, והסיכום מגיע אליכם בעברית.' },
  { q: 'מה אם המספר של מי שהתקשר חסוי?', a: 'אי אפשר לכתוב למספר חסוי, אז מגיעה אליכם מיד הודעה שהתקשרו ממספר חסוי.' },
  { q: 'ומה אם אין לו וואטסאפ?', a: 'כשההודעה לא מגיעה אליו, מגיעה אליכם מיד הודעה עם המספר שלו, כדי שתתקשרו אליו בעצמכם.' },
  { q: 'מה עם התא הקולי שלי?', a: 'ההעברה מחליפה את התא הקולי. במקום הודעה קולית שצריך להאזין לה, מי שהתקשר מקבל הודעה בוואטסאפ ואתם מקבלים סיכום כתוב.' },
  { q: 'איך מבטלים את ההעברה?', a: 'מקלידים ##002# בחייגן, וכל ההעברות מתבטלות. כדי להפעיל שוב מקלידים את אותם שלושה קודים.' },
  { q: 'אפשר לעצור את זה לזמן מה, למשל בחופש?', a: 'כן. כותבים למוקדן בוואטסאפ "לעצור", והוא לא כותב למתקשרים עד שכותבים לו "להמשיך".' },
  { q: 'איך אני יודע שזה עובד?', a: 'אחרי שמקלידים את הקודים, מבקשים ממישהו להתקשר אליכם ולא עונים. תוך כמה שניות הוא מקבל הודעה מהמוקדן, ואליכם מגיע הסיכום כשהוא עונה לו.' },
  // Never the words "חינם" or "הנחה" here: Toran's guard cuts any sentence that says them, even "אין חודש חינם" (the
  // second run, 2026-11-23), and leaves the rest of the reply without it.
  { q: 'יש תקופת ניסיון?', a: 'אין תקופת ניסיון, אבל אפשר לנסות את המוקדן על עצמכם בדף לדוגמה, זה לוקח דקה. ומשלמים חודש בחודש, בלי התחייבות.' },
  { q: 'איך יוצרים איתכם קשר?', a: 'כותבים לנו כאן בוואטסאפ. כשצריך, נציג מהצוות שלנו עונה כאן.' },
  { q: 'יש התחייבות?', a: 'לא. משלמים חודש מראש, ומי שרוצה להפסיק כותב לנו לפני החודש הבא.' },
  { q: 'כמה זמן לוקח להתחיל?', a: 'תוך 24 שעות מהרגע שהתשלום הגיע מגיעים אליכם המספר והקודים. אצלכם זה לוקח דקה: שלושה קודים בחייגן.' },
  { q: 'מה ההבדל ממזכירה או ממוקד טלפוני?', a: 'מזכירה או מוקד עונים לשיחה בטלפון. על הקו לא עונה לשיחה: הוא כותב למי שהתקשר בוואטסאפ בשם העסק שלכם, בכל שעה, ושולח לכם סיכום כתוב של מה הוא צריך.' },
  { q: 'למי זה מתאים?', a: 'לבעלי מקצוע שעונים לבד לטלפון ולא תמיד יכולים: אינסטלטורים, חשמלאים, טכנאי מזגנים, מנעולנים, וכל מי שהידיים שלו עסוקות כשהטלפון מצלצל.' },
  { q: 'מי שמתקשר משלם משהו על ההודעות?', a: 'לא. הוא מקבל הודעה בוואטסאפ ועונה בוואטסאפ, כמו כל הודעה אחרת.' },
  { q: 'כמה שיחות זה כולל?', a: 'כל שיחה שלא עניתם, באותו מחיר חודשי.' },
  // From the first run of these questions through Toran (2026-11-23): what it answered thin or wrong.
  { q: 'מה זה על הקו?', a: `שירות לבעלי מקצוע לשיחות שלא הספקתם לענות. על הקו לא עונה לשיחה: כשלא עניתם, מי שהתקשר מקבל תוך כמה שניות הודעה בוואטסאפ בשם העסק שלכם. המוקדן שלנו שואל אותו מה קרה, איפה וכמה דחוף, ושולח לכם סיכום עם המספר שלו, כדי שתחזרו אליו כשתתפנו. ${PRICE} ₪ לחודש לפני מע״מ.` },
  { q: 'אני עונה לרוב השיחות, למה אני צריך את זה?', a: 'בשביל השיחות שלא יוצא לענות: כשאתם על סולם, מתחת לכיור או באמצע שיחה אחרת. כל שיחה כזאת מקבלת מיד תשובה בוואטסאפ בשם העסק, ואתם מקבלים סיכום של מה צריך, כך ששום שיחה לא נשארת בלי מענה. השיחות שאתם עונים להן נשארות כמו היום.' },
  { q: 'הלקוחות שלי לא אוהבים לדבר עם רובוט', a: 'המוקדן לא מנסה להחליף אתכם. הוא כותב למי שהתקשר הודעה קצרה בשם העסק, שראו שהוא התקשר ושיחזרו אליו, ושואל שתיים שלוש שאלות: מה קרה, איפה וכמה דחוף. את השיחה עצמה, המחיר והמועד אתם עושים כמו היום. אפשר לראות בדף לדוגמה בדיוק מה הוא כותב.' },
  { q: 'מי רואה את הפרטים של מי שהתקשר אליי?', a: 'אתם. הסיכום מגיע אליכם לוואטסאפ, ואנחנו מחזיקים את השיחה בשבילכם רק כדי לתת את השירות. כדי לנסח את השאלות ואת הסיכום ההודעות עוברות למודל Claude של Anthropic, שלא מתאמן עליהן, ואנחנו לא מוכרים אותן. השיחות והסיכומים נמחקים אצלנו 90 יום אחרי השיחה. הפרטים המלאים במדיניות הפרטיות.' },
  { q: 'זה עובד בכל חברה סלולרית? פלאפון, סלקום, פרטנר?', a: 'ההעברה נעשית בקודים הרגילים להעברת שיחות בטלפון נייד, שמקלידים בחייגן. אם אצלכם משהו לא עובד אחרי שהקלדתם, כותבים לנו כאן ונעזור.' },
];

/** The export, from the pages in this repository and SITE_URL. */
export function supportExport(env, at = new Date()) {
  const site = String(env.SITE_URL || '').replace(/\/+$/, '');
  if (!/^https:\/\//.test(site)) throw new Error('SITE_URL must be the https address of the site');
  const domain = String(env.TORAN_DOMAIN || new URL(site).hostname).toLowerCase();
  const index = page('index.html');
  // The owner's name and personal email are on the legal pages because the law asks for them there; Toran does not
  // repeat them in a chat (it gave the email in one, 2026-11-23): where a page says to email us, Toran's copy says
  // WhatsApp, this very chat, and the page itself stays as it is.
  const noEmail = (html) =>
    html
      .replace(/ או שולחים מייל ל־<a href="mailto:[^"]*"[^>]*>[^<]*<\/a>/g, '')
      .replace(/במייל ל־<a href="mailto:[^"]*"[^>]*>[^<]*<\/a> או /g, '')
      .replace(/(?:במייל )?ל־<a href="mailto:[^"]*"[^>]*>[^<]*<\/a>/g, 'בוואטסאפ')
      .replace(/<a href="mailto:[^"]*"[^>]*>[^<]*<\/a>/g, 'בוואטסאפ')
      .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '');
  const terms = noEmail(page('terms.html'));
  const privacy = noEmail(page('privacy.html').replace(/,?\s*עסק של <bdi>[^<]*<\/bdi>/g, ''));
  const accessibility = noEmail(page('accessibility.html'));
  const whatsapp = (/wa\.me\/(\d{11,15})/.exec(index) || [])[1] || null;
  const email = null;
  const onSite = faqOf(index);
  // The sample page (demo.js): what a tradesperson's own page looks like, with the try of המוקדן on it.
  const sample = { q: 'אפשר לראות דוגמה לפני שמצטרפים?', a: `כן, בדף לדוגמה: ${site}/p/demo. רואים שם מה מקבל מי שהתקשר ומה מגיע אליכם, ואפשר לנסות את המוקדן על עצמכם בוואטסאפ, זה לוקח דקה.`, url: `${site}/p/demo` };
  const faq = [...onSite.map((f) => ({ ...f, url: `${site}/#faq` })), ...MORE.filter((m) => !onSite.some((f) => f.q === m.q)).map((m) => ({ ...m, url: `${site}/` })), sample].map((f) => ({ q: f.q, a: f.a, today: null, url: f.url }));
  return {
    domain,
    url: `${site}/`,
    name: 'על הקו',
    status: STATUS,
    start: { kind: 'join', text: START },
    // No name: the sales bot opens with "היי, אני הבוט של על הקו." (the owner, 2026-11-21). "" clears any name Toran
    // has for it. המוקדן, the blue one, is the assistant number that does the work (docs/connecting.md).
    botName: '',
    tone: textOf((/<p class="lead">([\s\S]*?)<\/p>/.exec(index) || [, ''])[1]),
    contact: { whatsapp, email },
    plans: [{ key: 'monthly', product: 'על הקו', title: 'על הקו, לחודש', monthly: PRICE, text: `${PRICE} ₪ לחודש, לא כולל מע״מ (${withVat} ₪ כולל מע״מ). כולל את המספר שאליו עוברות השיחות ואת ההודעות בוואטסאפ. אין דמי הקמה, ומשלמים חודש מראש בהעברה בנקאית.`, url: `${site}/#price` }],
    faq,
    pages: [
      // Each page at its own address: Toran keeps one page for each address of a store.
      { kind: 'about', title: 'מה עובד היום, ומה עוד לא', url: `${site}/#today`, text: STATUS },
      { kind: 'about', title: 'איך על הקו עובד', url: `${site}/#how`, text: textOf(mainOf(index)) },
      { kind: 'payment', title: 'מחיר ותשלום', url: `${site}/#price`, text: [MORE[0].a, MORE[1].a, MORE[2].a].join('\n') },
      { kind: 'about', title: 'דף לדוגמה', url: `${site}/p/demo`, text: sample.a },
      { kind: 'terms', title: titleOf(terms), url: `${site}/terms`, text: textOf(mainOf(terms)) },
      { kind: 'privacy', title: titleOf(privacy), url: `${site}/privacy`, text: textOf(mainOf(privacy)) },
      { kind: 'accessibility', title: titleOf(accessibility), url: `${site}/accessibility`, text: textOf(mainOf(accessibility)) },
    ],
    generatedAt: at.toISOString(),
  };
}
