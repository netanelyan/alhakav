// Israeli phone numbers, kept the way WhatsApp and Meta write them: the country code and no leading 0 (972541234567).
// A lead is written to only on a mobile (05X), the number a tradesperson carries on the job: a landline or a 07X
// number may not have WhatsApp at all, and a 1-700 or a *XXXX number is a call centre's.

const MOBILE = /^9725[0-58]\d{7}$/;

export const isMobile = (n) => MOBILE.test(String(n || ''));

/** 972XXXXXXXXX from any way an Israeli number is written, or null when it is not one. */
export function normalize(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('00972')) d = d.slice(2);
  if (d.startsWith('972')) d = d.slice(3);
  if (d.startsWith('0')) d = d.slice(1);
  // The national number: 5XXXXXXXX a mobile, 7XXXXXXXX a VoIP line, [2-489]XXXXXXX a landline.
  if (/^[57]\d{8}$/.test(d) || /^[2-489]\d{7}$/.test(d)) return `972${d}`;
  return null;
}

/** 054-123-4567, 03-123-4567. */
export function local(n) {
  const d = `0${String(n || '').slice(3)}`;
  return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : `${d.slice(0, 2)}-${d.slice(2, 5)}-${d.slice(5)}`;
}

/** The last four digits, for log lines. */
export const masked = (n) => `•••${String(n || '').slice(-4)}`;

// Where a site writes its numbers: a WhatsApp link (the number it chats on), a tel: link, and the visible text.
const WA = /(?:wa\.me\/|whatsapp\.com\/send\/?\?(?:[^"'\s<>]*?&(?:amp;)?)?phone=|whatsapp:\/\/send\/?\?(?:[^"'\s<>]*?&(?:amp;)?)?phone=)(\+?[\d-]{8,16})/gi;
const TEL = /href\s*=\s*["']tel:([^"']{6,30})["']/gi;
const TEXT = /(?<![\d*+])(?:\+?972[-\s.]?|0)(?:5\d|7\d|[2-489])(?:[-\s.]?\d){7}(?!\d)/g;
const SPECIAL = /(?<!\d)1[-\s]?(?:700|800|599)(?:[-\s]?\d){6}(?!\d)|(?<![\w*])\*\d{4}(?!\d)/g;

/** Every number a page has, by kind: mobiles, other lines, the ones its WhatsApp links go to, and call-centre numbers. */
export function phonesIn(html, text) {
  const mobiles = new Set();
  const others = new Set();
  const whatsapp = new Set();
  const specials = new Set();
  const put = (raw) => {
    const n = normalize(raw);
    if (!n) return null;
    (isMobile(n) ? mobiles : others).add(n);
    return n;
  };
  for (const m of String(html || '').matchAll(WA)) {
    const n = put(m[1]);
    if (n) whatsapp.add(n);
  }
  for (const m of String(html || '').matchAll(TEL)) {
    if (/^\s*\+?\s*1[-\s]?(?:700|800|599)/.test(m[1])) specials.add(m[1].replace(/\s+/g, ''));
    else put(m[1]);
  }
  for (const m of String(text || '').matchAll(TEXT)) put(m[0]);
  for (const m of String(text || '').matchAll(SPECIAL)) specials.add(m[0].replace(/\s+/g, ''));
  return { mobiles: [...mobiles], others: [...others], whatsapp: [...whatsapp], specials: [...specials] };
}
