import { createPublicKey, verify } from 'node:crypto';

// Telnyx: each customer's own number, one Israeli number that takes the calls forwarded from the customer's mobile
// (Voice API, "Call Control") and so says whose caller it is. WhatsApp is not here: המוקדן, the one assistant number
// every customer shares, is on Meta's Cloud API (meta.js assistSettings). Read in Telnyx's docs on 2026-11-19
// (docs/connecting.md has the pages):
//
//   calls       a webhook per event, `call.initiated` carrying `from` (the caller) and `to` (the assistant number),
//               then commands on POST /v2/calls/{call_control_id}/actions/<answer|reject|playback_start|record_start|
//               hangup>
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

// ---- numbers (numbers.js)

/** The numbers on a voice app: [{ id, number (E.164), status }]. */
export async function numbersOn(t, f, connectionId) {
  const out = await call(t, f, 'GET', `/phone_numbers?filter[connection_id]=${encodeURIComponent(connectionId)}&page[size]=250`);
  return (out?.data || []).map((n) => ({ id: String(n.id), number: String(n.phone_number), status: String(n.status || '') }));
}

/** Israeli local numbers for calls that can be bought now, with their price in dollars. */
export async function availableNumbers(t, f) {
  const out = await call(t, f, 'GET', '/available_phone_numbers?filter[country_code]=IL&filter[phone_number_type]=local&filter[features]=voice&filter[limit]=5');
  return (out?.data || []).map((n) => ({ number: String(n.phone_number), upfront: Number(n.cost_information?.upfront_cost), monthly: Number(n.cost_information?.monthly_cost) }));
}

/** Buy one number onto the voice app, with the requirement group Telnyx asks of an Israeli number. */
export async function orderNumber(t, f, number, connectionId, groupId, reference) {
  const out = await call(t, f, 'POST', '/number_orders', { phone_numbers: [{ phone_number: number, requirement_group_id: groupId }], connection_id: connectionId, customer_reference: reference });
  return { id: String(out?.data?.id || ''), status: String(out?.data?.status || '') };
}

/**
 * Where Telnyx's review of our documents stands (the requirement group every Israeli number is bought with):
 * { status, requirements: [{ type, status, reason }] }, with whatever reason Telnyx gives for one it did not approve.
 */
export async function requirementGroup(t, f, id) {
  const d = (await call(t, f, 'GET', `/requirement_groups/${encodeURIComponent(id)}`))?.data || {};
  const reason = (r) => [r.status_reason, r.rejection_reason, r.reason, r.comment, r.comments].find((x) => typeof x === 'string' && x.trim()) || '';
  return {
    status: String(d.status || ''),
    requirements: (d.regulatory_requirements || []).map((r) => ({ type: String(r.field_type || ''), status: String(r.status || ''), reason: reason(r) })),
  };
}

// ---- calls

export const callAction = (t, f, id, action, body = {}) => call(t, f, 'POST', `/calls/${encodeURIComponent(id)}/actions/${action}`, body);

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
