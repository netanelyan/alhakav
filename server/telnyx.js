import { createPublicKey, verify } from 'node:crypto';

// Telnyx: each customer's assistant number, one Israeli number that takes the calls forwarded from the customer's
// mobile (Voice API, "Call Control") and is a WhatsApp Business number (Telnyx is a WhatsApp partner). Read in Telnyx's
// docs on 2026-11-19 (docs/connecting.md has the pages):
//
//   calls       a webhook per event, `call.initiated` carrying `from` (the caller) and `to` (the assistant number),
//               then commands on POST /v2/calls/{call_control_id}/actions/<answer|reject|playback_start|record_start|
//               hangup>
//   WhatsApp    POST /v2/messages/whatsapp {from, to, whatsapp_message}: a template to anyone, text inside the 24 hours
//               after their last message; events message.received, message.sent, message.finalized, message.read
//   registering POST /v2/whatsapp/business_accounts/{waba}/phone_numbers {phone_number, display_name,
//               verification_method}, then POST /v2/whatsapp/phone_numbers/{number}/verify {code}. Meta reads the
//               code aloud in a call to the number, so a number being verified records its calls (service.js)
//   webhooks    signed with Ed25519 over "{timestamp}|{body}" (headers telnyx-signature-ed25519, telnyx-timestamp),
//               the account's public key in TELNYX_PUBLIC_KEY; older than 5 minutes is refused
//
// TELNYX_API moves every call elsewhere (the tests point it at a fake). Numbers are E.164 at Telnyx (+972...) and
// digits here (972...).

export const API = 'https://api.telnyx.com/v2';

export function telnyxSettings(env) {
  const s = {
    key: String(env.TELNYX_API_KEY || '').trim(),
    publicKey: String(env.TELNYX_PUBLIC_KEY || '').trim(),
    waba: String(env.TELNYX_WABA_ID || '').trim(),
    profile: String(env.TELNYX_MESSAGING_PROFILE_ID || '').trim(),
    displayName: String(env.WA_DISPLAY_NAME || 'על הקו').trim(),
    base: String(env.TELNYX_API || API).replace(/\/+$/, ''),
  };
  return { ...s, ready: Boolean(s.key && s.publicKey) };
}

export const e164 = (digits) => `+${String(digits || '').replace(/\D/g, '')}`;
export const digits = (n) => String(n || '').replace(/\D/g, '');

export class TelnyxError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'TelnyxError';
    this.status = status;
    this.code = code;
  }
}

async function call(t, f, method, path, body) {
  const res = await f(`${t.base}${path}`, {
    method,
    headers: { authorization: `Bearer ${t.key}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const e = data?.errors?.[0] || {};
    throw new TelnyxError(String(e.detail || e.title || `HTTP ${res.status}`), res.status, e.code ? String(e.code) : null);
  }
  return data;
}

// ---- calls

export const callAction = (t, f, id, action, body = {}) => call(t, f, 'POST', `/calls/${encodeURIComponent(id)}/actions/${action}`, body);

// ---- WhatsApp

/** A template from `from` to `to`, its body's variables in order. Answers Telnyx's message id. */
export async function sendTemplate(t, f, from, to, name, params = [], lang = 'he') {
  const out = await call(t, f, 'POST', '/messages/whatsapp', {
    from: e164(from),
    to: e164(to),
    whatsapp_message: { type: 'template', template: { name, language: { policy: 'deterministic', code: lang }, components: params.length ? [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }] : [] } },
  });
  return String(out?.data?.id || '');
}

/** Plain text inside the 24 hours. */
export async function sendText(t, f, from, to, body) {
  const out = await call(t, f, 'POST', '/messages/whatsapp', { from: e164(from), to: e164(to), whatsapp_message: { type: 'text', text: { body: String(body).slice(0, 4000), preview_url: true } } });
  return String(out?.data?.id || '');
}

export const registerNumber = (t, f, number) =>
  call(t, f, 'POST', `/whatsapp/business_accounts/${encodeURIComponent(t.waba)}/phone_numbers`, { phone_number: e164(number), display_name: t.displayName, verification_method: 'voice', language: 'he' });

export const verifyNumber = (t, f, number, code) => call(t, f, 'POST', `/whatsapp/phone_numbers/${encodeURIComponent(e164(number))}/verify`, { code: String(code).replace(/\D/g, '') });

export const assignProfile = (t, f, number) => (t.profile ? call(t, f, 'PATCH', `/whatsapp/phone_numbers/${encodeURIComponent(e164(number))}/profile`, { profile_id: t.profile }) : null);

// ---- webhooks

const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');

/** Did Telnyx sign this body, within the last 5 minutes? */
export function signatureOk(publicKey, raw, signature, timestamp, nowMs = Date.now()) {
  if (!publicKey || !signature || !timestamp) return false;
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > 300) return false;
  try {
    const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(publicKey, 'base64')]), format: 'der', type: 'spki' });
    return verify(null, Buffer.from(`${timestamp}|${raw}`), key, Buffer.from(String(signature), 'base64'));
  } catch {
    return false;
  }
}

/**
 * One webhook, read: a call event or a WhatsApp event, with what the service needs and nothing else. Telnyx's WhatsApp
 * payload is read defensively: its docs show the sender in from.phone_number and the text in body.text.body.
 */
export function readEvent(body) {
  const d = body?.data || {};
  const p = d.payload || {};
  const type = String(d.event_type || '');
  if (type.startsWith('call.')) {
    return { kind: 'call', type, id: String(d.id || ''), callId: String(p.call_control_id || ''), from: digits(p.from), to: digits(p.to), direction: String(p.direction || ''), recording: p.recording_urls?.mp3 || p.public_recording_urls?.mp3 || null };
  }
  if (type.startsWith('message.')) {
    const b = p.body || {};
    const text = b.text?.body ?? b.button?.text ?? b.interactive?.button_reply?.title ?? b.interactive?.list_reply?.title ?? (typeof p.text === 'string' ? p.text : '') ?? '';
    const media = ['image', 'audio', 'video', 'document', 'sticker', 'location', 'contacts'].find((k) => b[k] || b.type === k);
    const to = Array.isArray(p.to) ? p.to[0] : p.to;
    return {
      kind: 'whatsapp',
      type,
      id: String(p.id || d.id || ''),
      from: digits(p.from?.phone_number ?? p.from),
      to: digits(to?.phone_number ?? to),
      text: String(text || (media ? { image: '[תמונה]', audio: '[הודעה קולית]', video: '[וידאו]', document: '[קובץ]', sticker: '[סטיקר]', location: '[מיקום]', contacts: '[איש קשר]' }[media] : '')),
      button: Boolean(b.button || b.interactive),
      status: String(to?.status || ''),
      error: p.errors?.[0] ? String(p.errors[0].detail || p.errors[0].title || p.errors[0].code) : null,
      whatsapp: String(p.type || '').toUpperCase() === 'WHATSAPP' || Boolean(p.body),
    };
  }
  return { kind: 'other', type };
}
