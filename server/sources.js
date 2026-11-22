import { existsSync, readFileSync } from 'node:fs';
import { siteKey } from './detect.js';
import { normalize } from './phones.js';

// Where candidate sites come from. Every source yields { url, source, detail }; the discovery run decides what is new
// (openfrequency-toran's src/leads/sources.ts, for tradespeople instead of stores).
//
//   google  Google Places' Text Search (an official API, GOOGLE_MAPS_KEY), the same queries: each business comes with
//           the phone and the site it gave Google. One with a site of its own is read from that site, as Brave's are
//           (a site says the most, and the owner said a site makes the better lead); one without is a lead from its
//           listing alone (detect.js fromPlace). Asking for the phone and the site makes it Places' Enterprise
//           request: 1,000 a month free, then $35 per 1,000 (2026-11); three a day is 90 a month.
//   brave   the Brave Search API (an official API, never Google's results page): a trade and a city a query
//           ("אינסטלטור באשדוד"), rotated by day so each run asks new ones. Needs BRAVE_API_KEY.
//   seeds   private/seeds.txt: a site's address a line.
//
// Directories, marketplaces, social networks and news sites are dropped before they are read: they list
// tradespeople, they are not one. מדרג turns every request from the server away (403 from its CDN, robots.txt too,
// 2026-11-22), and the numbers pro.co.il shows look like its own forwarding numbers rather than the tradesperson's
// mobile, so neither is a source; Facebook groups have no API and are behind a login, so a tradesperson found there
// is added by hand (leads.js addByHand).

export const SEARCH_TRADES = { plumber: 'אינסטלטור', electrician: 'חשמלאי', ac: 'טכנאי מזגנים', locksmith: 'מנעולן' };

export const SEARCH_CITIES = [
  'אשדוד', 'תל אביב', 'ירושלים', 'חיפה', 'ראשון לציון', 'פתח תקווה', 'נתניה', 'באר שבע', 'חולון', 'רמת גן', 'אשקלון', 'רחובות',
  'בת ים', 'בית שמש', 'כפר סבא', 'הרצליה', 'חדרה', 'מודיעין', 'רעננה', 'לוד', 'רמלה', 'נהריה', 'קריית גת', 'עפולה', 'כרמיאל',
  'קריית אתא', 'ראש העין', 'הוד השרון', 'גבעתיים', 'יבנה', 'נס ציונה', 'קריית מוצקין', 'אור יהודה', 'קריית אונו', 'גדרה', 'קריית מלאכי',
  'זכרון יעקב', 'פרדס חנה', 'טבריה', 'אילת', 'דימונה', 'נתיבות', 'אופקים', 'שדרות', 'בני ברק',
];

const SHAPES = ['{t} ב{c}', '{t} זמין ב{c}', '{t} מומלץ ב{c}'];

/** n queries for this day: every trade in a city, then the next city, then the next shape. */
export function queriesFor(day, n, { trade = '', city = '' } = {}) {
  const trades = trade && SEARCH_TRADES[trade] ? [trade] : Object.keys(SEARCH_TRADES);
  const cities = city ? [city.trim()] : SEARCH_CITIES;
  const out = [];
  for (let i = 0; i < n; i++) {
    const k = day * n + i;
    const t = trades[k % trades.length];
    const c = cities[Math.floor(k / trades.length) % cities.length];
    const s = SHAPES[Math.floor(k / (trades.length * cities.length)) % SHAPES.length];
    out.push({ q: s.replace('{t}', SEARCH_TRADES[t]).replace('{c}', c), trade: t, city: c });
  }
  return out;
}

const NOT_ONE = /(?:^|\.)(?:b144|d|easy|midrag|zap|homeless|yad2|facebook|fb|instagram|tiktok|youtube|youtu|wikipedia|google|waze|linkedin|x|twitter|pinterest|reddit|ynet|walla|mako|ice|maariv|haaretz|themarker|globes|calcalist|kikar|bhol|sport5|one|rest|144|bezeq|dapeizahav|dapei-zahav|bonimbait|winwin|mekomi|kamazon|wolt|10bis|apple|tripadvisor|alljobs|drushim|jobmaster|madlan|govmap|duns100|bdi|nadlan|rav-kav|leumi|hapoalim|ksp|ivory|bug|lastprice|ace|homecenter|kitchen|hamlatza|hashoveh|meser|tozeret|yellowpages|cylex|hotfrog|biz|startpage|bing|yahoo|duckduckgo|amazon|aliexpress|ebay|wix|medium|tapuz|fxp|rotter|quora)\.(?:co\.il|org\.il|net\.il|com|co|net|org|il|me|info)$/i;

/** A host that lists tradespeople or is not a business site at all. */
export const notABusiness = (host) => NOT_ONE.test(host) || /\.(?:gov|ac|muni|k12|idf)\.il$/i.test(host);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The address to read a site at, or null when it is not a business's own (none, a directory, a social page). */
function ownSite(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const key = siteKey(u.href);
  if (!key || notABusiness(u.hostname.toLowerCase().replace(/^www\./, ''))) return null;
  // A site of its own is read from its home page; one on a shared builder from its own first segment.
  return key.includes('/') ? `${u.origin}/${key.split('/')[1]}` : `${u.origin}/`;
}

/** Candidates, one source after another. */
export async function* together(...sources) {
  for (const s of sources) yield* s;
}

const PLACES = 'https://places.googleapis.com/v1/places:searchText';
const PLACE_FIELDS = ['id', 'displayName', 'formattedAddress', 'websiteUri', 'nationalPhoneNumber', 'internationalPhoneNumber', 'googleMapsUri', 'businessStatus', 'types', 'rating', 'userRatingCount']
  .map((f) => `places.${f}`)
  .join(',');

export async function* places({ apiKey, queries, fetchImpl = fetch }) {
  for (const q of queries) {
    const res = await fetchImpl(PLACES, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey, 'x-goog-fieldmask': PLACE_FIELDS },
      body: JSON.stringify({ textQuery: q.q, languageCode: 'he', regionCode: 'IL', pageSize: 20 }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401 || res.status === 403) throw new Error(`Google refused the key (${res.status})`);
    if (res.status === 429) throw new Error('Google rate limit reached');
    if (!res.ok) continue;
    const data = await res.json().catch(() => null);
    for (const p of data?.places || []) {
      if (!p.id || (p.businessStatus && p.businessStatus !== 'OPERATIONAL')) continue;
      const place = {
        id: String(p.id),
        name: String(p.displayName?.text || '').trim().slice(0, 120),
        phone: normalize(p.internationalPhoneNumber || p.nationalPhoneNumber),
        address: String(p.formattedAddress || '').slice(0, 200),
        maps: String(p.googleMapsUri || `https://www.google.com/maps/place/?q=place_id:${p.id}`),
        types: (p.types || []).slice(0, 12),
        rating: Number(p.rating) || null,
        reviews: Number(p.userRatingCount) || 0,
      };
      const detail = { query: q.q, trade: q.trade, city: q.city, title: place.name, place };
      const site = ownSite(p.websiteUri);
      yield site ? { url: site, source: 'google', detail } : { url: place.maps, key: `g:${place.id}`, source: 'google', detail };
    }
  }
}

export async function* brave({ apiKey, queries, perQuery = 20, fetchImpl = fetch, pause = 1100 }) {
  for (const [i, q] of queries.entries()) {
    if (i && pause) await sleep(pause); // Brave's free tier takes one query a second
    const u = new URL('https://api.search.brave.com/res/v1/web/search');
    u.searchParams.set('q', q.q);
    u.searchParams.set('count', String(perQuery));
    u.searchParams.set('search_lang', 'he');
    u.searchParams.set('country', 'ALL'); // Brave refuses country=IL (found in openfrequency's tiyul-social)
    const res = await fetchImpl(u, { headers: { accept: 'application/json', 'x-subscription-token': apiKey }, signal: AbortSignal.timeout(15_000) });
    if (res.status === 401 || res.status === 403) throw new Error(`Brave refused the key (${res.status})`);
    if (res.status === 429) throw new Error('Brave rate limit reached');
    if (!res.ok) continue;
    const data = await res.json().catch(() => null);
    for (const r of data?.web?.results || []) {
      const url = ownSite(r.url);
      if (!url) continue;
      yield { url, source: 'brave', detail: { query: q.q, trade: q.trade, city: q.city, title: String(r.title || '').slice(0, 120) } };
    }
  }
}

export async function* seeds(file) {
  if (!file || !existsSync(file)) return;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const lineText = raw.replace(/#.*$/, '').trim();
    if (lineText) yield { url: /^https?:\/\//i.test(lineText) ? lineText : `https://${lineText}`, source: 'seed', detail: {} };
  }
}

export async function* fromUrls(urls, source = 'admin') {
  for (const u of urls) yield { url: /^https?:\/\//i.test(u) ? u : `https://${u}`, source, detail: {} };
}
