import { createHmac, timingSafeEqual } from 'node:crypto';
import { HOUR, MINUTE, now } from './clock.js';

// WhatsApp's Cloud API, on the business number (developers.facebook.com/docs/whatsapp/cloud-api), the calls
// openfrequency-toran's src/channels/meta.ts makes for its own number, and no more:
//
//   sending     POST /<phone id>/messages: an approved template to someone who has not written to us in the last 24
//               hours (the first message and the one reminder), plain text inside those 24 hours (the explanation
//               after "כן, שלחו", the line after "לא, תודה", and the admin's own answers)
//   quality     GET /<phone id>?fields=quality_rating: GREEN, YELLOW, RED or UNKNOWN, read before each first message
//   media       GET /<media id> for its address, then the file from there with the same token: a customer's picture of
//               their bank transfer (pay.js)
//   webhook     what Meta posts to /meta/webhook, signed with the app secret (X-Hub-Signature-256): the messages people
//               send us, and how far each of ours got (sent, delivered, read, failed)
//
// META_GRAPH moves every call elsewhere (the tests point it at a fake).

export const GRAPH = 'https://graph.facebook.com/v23.0';

export function metaSettings(env) {
  const s = {
    token: String(env.META_TOKEN || '').trim(),
    phoneId: String(env.META_PHONE_ID || '').trim(),
    wabaId: String(env.META_WABA_ID || '').trim(),
    appSecret: String(env.META_APP_SECRET || '').trim(),
    verifyToken: String(env.META_VERIFY_TOKEN || '').trim(),
    base: String(env.META_GRAPH || GRAPH).replace(/\/+$/, ''),
  };
  return { ...s, ready: Boolean(s.token && s.phoneId) };
}

/**
 * The assistant's own number, המוקדן (docs/connecting.md): a second number on the same WhatsApp Business Account, with
 * the same token, templates and webhook, that writes to every customer's callers and to the customers themselves.
 * ASSIST_PHONE_ID is its Meta id; ASSIST_NUMBER its digits (972...), for the pages.
 */
export function assistSettings(env) {
  const m = metaSettings(env);
  const phoneId = String(env.ASSIST_PHONE_ID || '').trim();
  return { ...m, phoneId, number: String(env.ASSIST_NUMBER || '').replace(/\D/g, ''), ready: Boolean(m.token && phoneId) };
}

export class GraphError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'GraphError';
    this.status = status;
    this.code = code;
  }
}

async function graph(m, f, method, path, body) {
  const res = await f(`${m.base}/${path}`, {
    method,
    headers: { authorization: `Bearer ${m.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || data?.error) {
    const e = data?.error || {};
    throw new GraphError(String(e.error_user_msg || e.error_data?.details || e.message || `HTTP ${res.status}`), res.status, Number(e.code) || null);
  }
  return data;
}

/** A template to `to`, with its body's variables in order. Answers Meta's message id. */
export async function sendTemplate(m, f, to, name, params = [], lang = 'he', { url } = {}) {
  const components = params.length ? [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }] : [];
  // A link button's {{1}}, the end of its address (the first message's "לראות את הדף שלכם": the page's code).
  if (url) components.push({ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: url }] });
  const out = await graph(m, f, 'POST', `${m.phoneId}/messages`, {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: { name, language: { code: lang }, components },
  });
  return String(out?.messages?.[0]?.id || '');
}

/** A caller's words as a value in a message: none of WhatsApp's marks (* _ ~ `), which would bold or strike its parts. */
export const plainWords = (s) => String(s || '').replace(/[*_~`]+/g, '').replace(/\s+/g, ' ').trim();

/** Plain text to `to`, inside the 24 hours after their last message. Answers Meta's message id. */
export async function sendText(m, f, to, body) {
  const out = await graph(m, f, 'POST', `${m.phoneId}/messages`, { messaging_product: 'whatsapp', to, type: 'text', text: { body, preview_url: true } });
  return String(out?.messages?.[0]?.id || '');
}

/** Where Meta's review of a template stands: APPROVED, PENDING, REJECTED, PAUSED, DISABLED, or MISSING. */
export async function templateStatus(m, f, name, lang = 'he') {
  if (!m.wabaId) return 'UNKNOWN';
  const out = await graph(m, f, 'GET', `${m.wabaId}/message_templates?name=${encodeURIComponent(name)}&fields=name,status,language`);
  const t = (out?.data || []).find((x) => x.name === name && (x.language || lang) === lang);
  return t ? String(t.status || 'UNKNOWN').toUpperCase() : 'MISSING';
}

// Meta's review of each template, read at most once an hour (ten minutes after a failed read).
const reviews = new Map();
export const forgetTemplates = () => reviews.clear();
/** The last review read of a template, with no call to Meta: what the admin's pages show while they wait for none. */
export const knownStatus = (name) => reviews.get(name)?.status || null;

export async function review(m, f, name, lang = 'he') {
  const had = reviews.get(name);
  if (had && now() - had.at < (had.status === 'UNKNOWN' ? 10 * MINUTE : HOUR)) return had;
  let r = { status: 'UNKNOWN', category: '' };
  try {
    const out = await graph(m, f, 'GET', `${m.wabaId}/message_templates?name=${encodeURIComponent(name)}&fields=name,status,category,language`);
    const t = (out?.data || []).find((x) => x.name === name && (x.language || lang) === lang);
    r = t ? { status: String(t.status || 'UNKNOWN').toUpperCase(), category: String(t.category || '').toUpperCase() } : { status: 'MISSING', category: '' };
  } catch {}
  reviews.set(name, { ...r, at: now() });
  return r;
}

/**
 * The first of `names` Meta approved as Utility, else the first approved, else the first. A reworded template takes
 * over by itself once it is approved: Meta holds a Marketing one from someone who already gets many (131049), and
 * charges more for it.
 */
export async function pickTemplate(m, f, names, lang = 'he') {
  if (names.length < 2 || !m.wabaId) return names[0];
  const seen = [];
  for (const name of names) seen.push([name, await review(m, f, name, lang)]);
  // None approved: the first; but when Meta could not be asked about any, the last, the oldest, which went before.
  const none = seen.every(([, r]) => r.status === 'UNKNOWN') ? seen.at(-1) : seen[0];
  return (seen.find(([, r]) => r.status === 'APPROVED' && r.category === 'UTILITY') || seen.find(([, r]) => r.status === 'APPROVED') || none)[0];
}

export async function numberQuality(m, f) {
  const out = await graph(m, f, 'GET', `${m.phoneId}?fields=quality_rating`);
  return String(out?.quality_rating || 'UNKNOWN').toUpperCase();
}

// The token goes only to Meta's own hosts, never to one named only in an answer.
const META_HOST = /(^|\.)(fbsbx\.com|facebook\.com|fbcdn\.net|whatsapp\.net)$/i;

/** A file someone sent us: { data (a Buffer), mime }. Throws GraphError, also when it is over `max` bytes. */
export async function downloadMedia(m, f, mediaId, max) {
  const info = await graph(m, f, 'GET', encodeURIComponent(mediaId));
  if (Number(info?.file_size) > max) throw new GraphError('too large', 413, null);
  let u;
  try {
    u = new URL(String(info?.url || ''));
  } catch {
    throw new GraphError('no address for the file', 0, null);
  }
  if (u.protocol !== 'https:' || !(META_HOST.test(u.hostname) || u.host === new URL(m.base).host)) throw new GraphError('the file is not on Meta', 0, null);
  const res = await f(u.href, { headers: { authorization: `Bearer ${m.token}` }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new GraphError(`HTTP ${res.status}`, res.status, null);
  const data = Buffer.from(await res.arrayBuffer());
  if (data.length > max) throw new GraphError('too large', 413, null);
  return { data, mime: String(info?.mime_type || '') };
}

/** Did Meta sign this body? (X-Hub-Signature-256: sha256=<HMAC-SHA256 of the raw body under the app secret>) */
export function signatureOk(appSecret, raw, header) {
  if (!appSecret) return false;
  const want = Buffer.from(`sha256=${createHmac('sha256', appSecret).update(raw).digest('hex')}`);
  const got = Buffer.from(String(header || ''));
  return want.length === got.length && timingSafeEqual(want, got);
}

const MEDIA = { image: '[תמונה]', audio: '[הודעה קולית]', video: '[וידאו]', document: '[קובץ]', sticker: '[סטיקר]', location: '[מיקום]', contacts: '[איש קשר]' };

/** A webhook's messages to us and the statuses of ours. A reaction is not a message: it is left out. */
export function parseWebhook(body) {
  const messages = [];
  const statuses = [];
  for (const entry of body?.entry || []) {
    for (const change of entry?.changes || []) {
      if (change?.field && change.field !== 'messages') continue;
      const v = change?.value || {};
      // Which of our numbers it is about: the business number, or the assistant's (outreach.js onWebhook splits them).
      const phoneId = String(v.metadata?.phone_number_id || '');
      const names = Object.fromEntries((v.contacts || []).map((c) => [String(c.wa_id), String(c.profile?.name || '')]));
      for (const msg of v.messages || []) {
        if (msg.type === 'reaction') continue;
        const button = msg.type === 'button' || msg.interactive?.type === 'button_reply';
        const text =
          msg.type === 'text' ? msg.text?.body
          : msg.type === 'button' ? msg.button?.text
          : msg.type === 'interactive' ? msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title
          : MEDIA[msg.type] || `[${msg.type}]`;
        messages.push({
          id: String(msg.id || ''),
          from: String(msg.from || ''),
          at: Number(msg.timestamp) ? Number(msg.timestamp) * 1000 : null,
          type: button ? 'button' : String(msg.type || ''),
          text: String(text || ''),
          media: ['image', 'document'].includes(msg.type) && msg[msg.type]?.id ? { id: String(msg[msg.type].id), mime: String(msg[msg.type].mime_type || ''), name: String(msg[msg.type].filename || '') } : null,
          name: names[String(msg.from)] || '',
          phoneId,
        });
      }
      for (const s of v.statuses || []) {
        const err = s.errors?.[0];
        statuses.push({ id: String(s.id || ''), status: String(s.status || ''), to: String(s.recipient_id || ''), error: err ? { code: Number(err.code) || null, title: String(err.title || err.message || '') } : null, phoneId });
      }
    }
  }
  return { messages, statuses };
}
