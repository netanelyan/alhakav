import { isMobile, phonesIn } from './phones.js';

// What a tradesperson's site says about them: which of the four trades, where they work, the number to write to, and
// what tells a one-person business from a call centre, a chain or a directory. Read from the home page, and from its
// contact page when the home page has no mobile. No dependencies: the few things needed are read with patterns, as in
// openfrequency-toran's src/leads/signals.ts.

export const TRADES = {
  plumber: /אינסטלטור|אינסטלציה|פתיחת סתימ|סתימות|איתור נזיל|דוד(?:י)? שמש|plumb/gi,
  electrician: /חשמלאי|עבודות חשמל|תיקוני חשמל|לוח(?:ות)? חשמל|הארק(?:ה|ות)|electrician/gi,
  ac: /מזגנ|מיזוג אוו?יר|טכנאי מיזוג|air ?condition/gi,
  locksmith: /מנעולן|מנעולנים|פריצת דל|פריצת רכב|צילינדר|locksmith/gi,
};

// Israel's cities and towns, as people write them; a variant spelling is reported as the first form (CITY_AS).
export const CITIES = [
  'תל אביב', 'ירושלים', 'חיפה', 'ראשון לציון', 'פתח תקווה', 'פתח תקוה', 'אשדוד', 'נתניה', 'באר שבע', 'חולון', 'בני ברק', 'רמת גן',
  'אשקלון', 'רחובות', 'בת ים', 'בית שמש', 'כפר סבא', 'הרצליה', 'חדרה', 'מודיעין', 'רעננה', 'לוד', 'רמלה', 'נהריה', 'קריית גת', 'קרית גת',
  'עפולה', 'כרמיאל', 'קריית אתא', 'קרית אתא', 'ראש העין', 'הוד השרון', 'גבעתיים', 'יבנה', 'אילת', 'טבריה', 'נס ציונה', 'קריית מוצקין',
  'קרית מוצקין', 'קריית ביאליק', 'קרית ביאליק', 'קריית ים', 'קרית ים', 'אור יהודה', 'קריית אונו', 'קרית אונו', 'יהוד', 'נשר', 'צפת',
  'דימונה', 'אופקים', 'שדרות', 'נתיבות', 'גדרה', 'גן יבנה', 'קריית מלאכי', 'קרית מלאכי', 'זכרון יעקב', 'פרדס חנה', 'כפר יונה', 'אור עקיבא',
  'טירת כרמל', 'קריית שמונה', 'קרית שמונה', 'מעלה אדומים', 'ביתר עילית', 'מודיעין עילית', 'עכו', 'נצרת', 'רהט', 'גבעת שמואל',
  'קריית טבעון', 'יקנעם', 'מגדל העמק', 'בית שאן', 'ערד', 'אריאל', 'באר יעקב', 'מזכרת בתיה', 'קדימה', 'תל מונד', 'אבן יהודה', 'גבעת זאב',
  'כוכב יאיר', 'ראש פינה', 'קצרין', 'מבשרת ציון', 'אלפי מנשה', 'קריית ארבע', 'שוהם',
];
const CITY_AS = { 'פתח תקוה': 'פתח תקווה', 'קרית גת': 'קריית גת', 'קרית אתא': 'קריית אתא', 'קרית מוצקין': 'קריית מוצקין', 'קרית ביאליק': 'קריית ביאליק', 'קרית ים': 'קריית ים', 'קרית אונו': 'קריית אונו', 'קרית מלאכי': 'קריית מלאכי', 'קרית שמונה': 'קריית שמונה' };
// A city's name with its one or two prefix letters (באשדוד, ובאשדוד, לחיפה) and nothing glued after it.
const CITY_RE = CITIES.map((c) => [CITY_AS[c] || c, new RegExp(`(?:^|[^\\u0590-\\u05FF])[ובלמ]{0,2}${c}(?![\\u0590-\\u05FF])`, 'g')]);

// A chain, a call centre or a company with branches, in what such sites say about themselves.
const CHAIN = /מוקד (?:ארצי|שירות|הזמנות)|סניפי(?:ם|נו)|פריסה ארצית|בכל (?:רחבי )?(?:הארץ|ישראל)|רשת (?:ה)?(?:מנעולנים|אינסטלטורים|חשמלאים|טכנאים)|זכיינ/;
// A person talking about their own work: a sign of one tradesperson rather than a company.
const OWNER = /(?:^|[^֐-׿])(?:שמי|נעים מאוד|אני (?:אינסטלטור|חשמלאי|טכנאי|מנעולן|מגיע|עובד|נותן))(?![֐-׿])/;
const GENERIC = /^(?:דף הבית|עמוד הבית|ראשי|בית|home(?: ?page)?|main)$/i;
// Site builders that host many businesses on one host: the first path segment is part of who the site is.
const SHARED = /(?:^|\.)(?:wixsite\.com|site123\.me|mystrikingly\.com|webnode\.(?:com|co\.il)|wordpress\.com|business\.site|godaddysites\.com|weebly\.com|jimdosite\.com|carrd\.co|my\.canva\.site|ueniweb\.com)$/i;

function decode(s) {
  return String(s || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => (Number(n) > 0 && Number(n) < 0x110000 ? String.fromCodePoint(Number(n)) : ' '))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => (parseInt(n, 16) > 0 && parseInt(n, 16) < 0x110000 ? String.fromCodePoint(parseInt(n, 16)) : ' '))
    .replace(/&amp;/g, '&');
}

const line = (s) => decode(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/** The site a URL belongs to: its host without www, with the first path segment on a shared site builder. */
export function siteKey(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(u.protocol)) return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (!host.includes('.')) return null;
  const first = u.pathname.split('/').filter(Boolean)[0];
  return SHARED.test(host) && first ? `${host}/${first.toLowerCase()}` : host;
}

/** One page, read: its title, description, headline, visible text, links, language and numbers. */
export function readPage(html, url) {
  const raw = String(html || '').slice(0, 2_000_000);
  const clean = raw.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, ' ');
  const meta = (name) => {
    const tag = new RegExp(`<meta\\b[^>]*(?:name|property)\\s*=\\s*["']${name}["'][^>]*>`, 'i').exec(clean)?.[0];
    return tag ? line(/content\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1]) : '';
  };
  const text = line(clean).slice(0, 80_000);
  const links = [];
  for (const m of clean.matchAll(/<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    try {
      links.push({ href: new URL(decode(m[1]), url).href, text: line(m[2]) });
    } catch {
      /* a link that is not one */
    }
  }
  const letters = text.match(/[A-Za-zא-ת]/g) || [];
  return {
    url,
    title: line(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(clean)?.[1]),
    description: meta('description') || meta('og:description'),
    siteName: meta('og:site_name'),
    h1: line(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(clean)?.[1]),
    text,
    lang: /<html\b[^>]*\blang\s*=\s*["']?([a-z-]+)/i.exec(raw)?.[1]?.toLowerCase() || '',
    dir: /<html\b[^>]*\bdir\s*=\s*["']?(rtl|ltr)/i.exec(raw)?.[1]?.toLowerCase() || '',
    hebrew: letters.length ? letters.filter((c) => c >= 'א').length / letters.length : 0,
    links,
    waWidget: /wa\.me\/|api\.whatsapp\.com|web\.whatsapp\.com|whatsapp:\/\//i.test(raw),
    phones: phonesIn(raw, text),
  };
}

const count = (re, s) => (String(s || '').match(new RegExp(re.source, 'gi')) || []).length;

/** The trade a site is about: its words counted, the title, headline and site name weighing most. */
export function tradeOf(p) {
  const hits = {};
  for (const [trade, re] of Object.entries(TRADES)) {
    hits[trade] = 5 * count(re, p.title) + 4 * count(re, `${p.h1} ${p.siteName}`) + 3 * count(re, p.description) + Math.min(count(re, p.text), 30);
  }
  const [trade, n] = Object.entries(hits).sort((a, b) => b[1] - a[1])[0];
  return n >= 3 ? { trade, hits: n } : { trade: null, hits: 0 };
}

/** The cities a text names, each once, in the order they first appear. */
export function citiesIn(text) {
  const found = [];
  for (const [city, re] of CITY_RE) {
    re.lastIndex = 0;
    const m = re.exec(String(text || ''));
    if (m && !found.some((f) => f.city === city)) found.push({ city, at: m.index });
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.city);
}

/** The name to call them by: the site's own name, else the shortest part of its title that is not "home". */
export function nameOf(p) {
  if (p.siteName && p.siteName.length <= 40 && !GENERIC.test(p.siteName)) return p.siteName;
  const parts = String(p.title || '')
    .split(/\s+[|\-–—•·:]\s+|\s*[|–—•·]\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length > 1 && !GENERIC.test(s));
  return (parts.find((s) => s.length <= 32) || parts[0] || p.h1 || siteKey(p.url) || '').slice(0, 60);
}

/** Everything the score needs, from the pages read of one site (the home page first). */
export function analyze(pages, finalUrl) {
  const [home] = pages;
  const all = (k) => [...new Set(pages.flatMap((p) => p.phones[k]))];
  const mobiles = all('mobiles');
  const whatsapp = all('whatsapp');
  // The number to write to: the one the site's WhatsApp link goes to when it is a mobile, else the first mobile shown.
  const mobile = whatsapp.find(isMobile) || mobiles[0] || null;
  const head = `${home.title} ${home.h1} ${home.description} ${home.siteName}`;
  const text = pages.map((p) => p.text).join(' ');
  const { trade, hits } = tradeOf({ ...home, text });
  const cities = [...new Set([...citiesIn(head), ...citiesIn(text)])];
  const chainWords = CHAIN.exec(text)?.[0];
  const year = Math.max(0, ...[...text.matchAll(/(?:©|כל הזכויות שמורות|all rights reserved)[^.|]{0,60}/gi)].flatMap((m) => (m[0].match(/20\d\d/g) || []).map(Number)));
  return {
    url: finalUrl,
    domain: siteKey(finalUrl),
    name: nameOf(home),
    about: (home.description || '').slice(0, 220),
    trade,
    tradeHits: hits,
    city: cities[0] || null,
    cities,
    mobile,
    mobiles,
    others: all('others'),
    specials: all('specials'),
    whatsappLinked: whatsapp.length > 0,
    waWidget: pages.some((p) => p.waWidget),
    hebrew: Math.max(...pages.map((p) => p.hebrew)),
    lang: home.lang,
    dir: home.dir,
    chain: chainWords ? `"${chainWords}"` : cities.length >= 8 ? `${cities.length} ערים באתר` : null,
    directory: mobiles.length >= 6 ? `${mobiles.length} מספרי נייד שונים באתר` : null,
    ownerVoice: OWNER.test(text),
    year: year || null,
  };
}

/** Read a site: its home page, and its contact page when the home page shows no mobile. */
export async function detect(url, { fetcher }) {
  const home = await fetcher(url);
  if (home.status >= 400) throw Object.assign(new Error(`the site answered ${home.status}`), { code: `http_${home.status}` });
  const first = readPage(home.text, home.url);
  const pages = [first];
  if (!first.phones.mobiles.length) {
    const site = siteKey(home.url);
    const contact = first.links.find((l) => siteKey(l.href) === site && l.href !== home.url && /צור קשר|צרו קשר|יצירת קשר|contact/i.test(`${l.text} ${l.href}`));
    if (contact) {
      try {
        const r = await fetcher(contact.href);
        if (r.status < 400) pages.push(readPage(r.text, r.url));
      } catch {
        /* the home page is enough to go on */
      }
    }
  }
  return analyze(pages, home.url);
}
