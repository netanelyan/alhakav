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
  '- אחרי שהתשלום מגיע אנחנו מקימים לכם את זה ביד: נותנים לכם מספר שאליו יעברו השיחות שלא עניתם, שולחים לכם קוד להקליד בטלפון, ועושים שיחת בדיקה.',
  '- מי שהתקשר ולא עניתם לו מקבל בוואטסאפ הודעה מהמוקדן, המספר של על הקו, בשם העסק שלכם, מיד כשהשיחה נגמרת. המוקדן שואל מה קרה ואיפה, ושולח לכם לוואטסאפ מה הוא צריך.',
  '',
  'מה עוד לא:',
  '- אין הרשמה באתר. מצטרפים רק כאן בוואטסאפ.',
  '- אי אפשר לשלם בכרטיס אשראי. רק בהעברה בנקאית.',
  '- אין לנו תאריך קבוע לסיום ההקמה. נציג שלנו מתאם אותה איתכם אחרי התשלום.',
].join('\n');

const START = 'מצטרפים כאן בוואטסאפ: אומרים לנו את שם העסק כמו שמי שמתקשר צריך לראות אותו, ומקבלים מיד את הסכום ואת פרטי ההעברה. אחרי ההעברה שולחים כאן צילום של האישור, ואחרי שהתשלום מגיע מקימים לכם את העוזר.';

// Questions that come up in the chat and are not on the landing page.
const MORE = [
  { q: 'כמה זה עולה?', a: `${PRICE} ₪ לחודש, לא כולל מע״מ, כלומר ${withVat} ₪ כולל מע״מ. זה כולל את מספר העוזר ואת ההודעות בוואטסאפ. אין דמי הקמה.` },
  { q: 'איך משלמים?', a: 'בהעברה בנקאית, חודש מראש. את הסכום ואת פרטי החשבון שולחים לכם כאן בוואטסאפ. אחרי ההעברה שולחים כאן צילום מסך או PDF של האישור, ואחרי שבדקנו מול הבנק מגיעה חשבונית מס קבלה.' },
  { q: 'אפשר לשלם בכרטיס אשראי?', a: 'עוד לא. כרגע משלמים רק בהעברה בנקאית.' },
  { q: 'מה קורה אחרי שמשלמים?', a: 'נותנים לכם מספר שאליו יעברו השיחות שלא עניתם, ושולחים לכם קוד להקליד בטלפון. עושים שיחת בדיקה, ומשם המוקדן כותב לכל מי שהתקשר ולא עניתם, ושולח לכם לוואטסאפ מה הוא צריך.' },
  { q: 'איך אתם יודעים מה דחוף?', a: 'שואלים את מי שהתקשר. בנזילה, למשל, שואלים אם זה מטפטף או זורם. בסיכום רואים מה הוא ענה, ואתם מחליטים למי לחזור קודם.' },
  { q: 'מי עונה למי שמתקשר אליי, בן אדם?', a: 'המוקדן, מערכת AI שלנו, בשם העסק שלכם. הוא שואל מה קרה, איפה, וכמה זה דחוף, ושולח לכם לוואטסאפ מה הוא צריך. על מחיר ועל שעה הוא לא מתחייב.' },
  { q: 'ואם אחרי חודש אני רואה שזה לא שווה לי?', a: 'מפסיקים. משלמים חודש בחודש, ומי שרוצה להפסיק כותב לנו לפני החודש הבא. על חודש ששולם לא מחזירים כסף.' },
];

/** The export, from the pages in this repository and SITE_URL. */
export function supportExport(env, at = new Date()) {
  const site = String(env.SITE_URL || '').replace(/\/+$/, '');
  if (!/^https:\/\//.test(site)) throw new Error('SITE_URL must be the https address of the site');
  const domain = String(env.TORAN_DOMAIN || new URL(site).hostname).toLowerCase();
  const index = page('index.html');
  const terms = page('terms.html');
  // The owner's name is on the privacy page because the law asks for it there; Toran does not repeat it in a chat, it
  // sends the page instead.
  const privacy = page('privacy.html').replace(/,?\s*עסק של <bdi>[^<]*<\/bdi>/g, '');
  const accessibility = page('accessibility.html');
  const whatsapp = (/wa\.me\/(\d{11,15})/.exec(index) || [])[1] || null;
  const email = (/mailto:([^"?]+)/.exec(terms) || [])[1] || null;
  const onSite = faqOf(index);
  const faq = [...onSite.map((f) => ({ ...f, url: `${site}/#faq` })), ...MORE.filter((m) => !onSite.some((f) => f.q === m.q)).map((m) => ({ ...m, url: `${site}/` }))].map((f) => ({ q: f.q, a: f.a, today: null, url: f.url }));
  return {
    domain,
    url: `${site}/`,
    name: 'על הקו',
    status: STATUS,
    start: { kind: 'join', text: START },
    // The sales bot's name in its first line, "היי, אני הסוכן, הבוט של על הקו.": the orange one, who sells and takes the
    // payments; המוקדן, the blue one, is the assistant number that does the work (docs/connecting.md).
    botName: 'הסוכן',
    tone: textOf((/<p class="lead">([\s\S]*?)<\/p>/.exec(index) || [, ''])[1]),
    contact: { whatsapp, email },
    plans: [{ key: 'monthly', product: 'על הקו', title: 'על הקו, לחודש', monthly: PRICE, text: `${PRICE} ₪ לחודש, לא כולל מע״מ (${withVat} ₪ כולל מע״מ). כולל את המספר שאליו עוברות השיחות ואת ההודעות בוואטסאפ. אין דמי הקמה, ומשלמים חודש מראש בהעברה בנקאית.`, url: `${site}/#price` }],
    faq,
    pages: [
      // Each page at its own address: Toran keeps one page for each address of a store.
      { kind: 'about', title: 'מה עובד היום, ומה עוד לא', url: `${site}/#today`, text: STATUS },
      { kind: 'about', title: 'איך על הקו עובד', url: `${site}/#how`, text: textOf(mainOf(index)) },
      { kind: 'payment', title: 'מחיר ותשלום', url: `${site}/#price`, text: [MORE[0].a, MORE[1].a, MORE[2].a].join('\n') },
      { kind: 'terms', title: titleOf(terms), url: `${site}/terms`, text: textOf(mainOf(terms)) },
      { kind: 'privacy', title: titleOf(privacy), url: `${site}/privacy`, text: textOf(mainOf(privacy)) },
      { kind: 'accessibility', title: titleOf(accessibility), url: `${site}/accessibility`, text: textOf(mainOf(accessibility)) },
    ],
    generatedAt: at.toISOString(),
  };
}
