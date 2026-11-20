import Anthropic from '@anthropic-ai/sdk';
import { TRADE } from './copy.js';

// The conversation with a caller, one turn at a time: the whole chat so far goes in, and what to answer comes back
// with what is known (what happened, where, how urgent) and whether that is enough. Claude Sonnet 5.5 at low effort
// (a short chat, not a hard problem: half Opus's price, and the caller waits less), the answer held to a JSON schema
// by structured outputs, and the server-side fallback on, so a request a safety classifier declines is answered by
// Anthropic's recommended fallback model instead of not at all. CLAUDE_MODEL=claude-opus-5-5 switches to Opus if the
// Hebrew slips in the pilot.

export const MODEL = 'claude-sonnet-5-5';

/** Claude, or null while ANTHROPIC_API_KEY is not set. Tests hand in their own. */
export function makeClaude(env) {
  const apiKey = String(env.ANTHROPIC_API_KEY || '').trim();
  if (!apiKey) return null;
  const client = new Anthropic({ apiKey });
  return { messages: client.beta.messages, model: String(env.CLAUDE_MODEL || MODEL) };
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reply', 'done', 'what', 'place', 'urgency'],
  properties: {
    reply: { type: 'string', description: 'The next WhatsApp message to the caller, in Hebrew.' },
    done: { type: 'boolean', description: 'True when the owner has enough to call back, or the caller has said all they will.' },
    what: { type: 'string', description: 'What happened, in a short Hebrew line, or empty.' },
    place: { type: 'string', description: 'Where: street, number, city, floor or anything about access, in a short Hebrew line, or empty.' },
    urgency: { type: 'string', description: 'How urgent, in the caller\'s own terms, in a short Hebrew line, or empty.' },
  },
};

/** The system prompt: stable per customer, so it caches across the turns of a conversation. */
export function systemPrompt(customer) {
  const trade = TRADE[customer.trade] || 'בעל מקצוע';
  return `You are the WhatsApp assistant of "${customer.business}", an Israeli ${trade} business. A person called the business, nobody could answer, and you wrote to them on WhatsApp on the business's behalf. Your one job: collect what the business needs to call them back ready, and nothing else.

Collect three things, one short question at a time: what happened, where (street and number, city, floor or access if it matters), and how urgent (can it wait until tomorrow?). Skip any question the person already answered. Two or three questions are usually enough.

How you write: plain everyday Hebrew, the way a person types on WhatsApp. Short. No greeting after the first message (it was already sent). No emoji, no exclamation marks, no lists. Address the caller in a form that fits any gender ("אפשר לשלוח", "מה הכתובת?"), never "את/ה". Refer to the business by its name, "${customer.business}", in plural ("הם יחזרו"), never by a guessed first name or gender.

What you never do: quote a price, give an arrival time, book, promise, or diagnose. If asked, say that ${customer.business} will call back and settle it with them. If asked something unrelated, say you only take the details for the callback.

Danger: if they describe a smell of gas, sparks or burning, water reaching electricity, a fire, or someone locked in who is at risk, tell them to call 102 (fire and rescue) or 101 (Magen David Adom) right now, before anything else, and set urgency to "דחוף מאוד: <the danger>".

When you have what, where and urgency, or the person has clearly said all they will, set done to true and make reply one closing line, for example: "תודה, הפרטים אצל ${customer.business} והם יחזרו אליך כשיתפנו." If they write again after that, answer briefly and update the fields.

Always fill what, place and urgency with everything known so far (short Hebrew lines, empty when unknown); they are sent to the business as the summary.`;
}

/** The chat so far, as one message: our lines and theirs, in order. */
export function transcript(messages) {
  return messages.map((m) => `${m.dir === 'out' ? 'העוזר' : 'הלקוח'}: ${m.body}`).join('\n');
}

/**
 * One turn. Answers { reply, done, what, place, urgency }, or throws when Claude declined or answered something that is
 * not the schema (the service then sends the summary with what it has, service.js).
 */
export async function intakeTurn(claude, customer, messages) {
  const res = await claude.messages.create({
    model: claude.model,
    max_tokens: 4000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    system: [{ type: 'text', text: systemPrompt(customer), cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: `השיחה עד עכשיו:\n${transcript(messages)}\n\nמה ההודעה הבאה?` }],
  });
  if (res.stop_reason === 'refusal') throw new Error(`Claude declined (${res.stop_details?.category || 'no category'})`);
  const text = res.content.find((b) => b.type === 'text')?.text;
  const out = JSON.parse(text || 'null');
  if (!out || typeof out.reply !== 'string' || typeof out.done !== 'boolean') throw new Error('Claude answered outside the schema');
  return { reply: out.reply.trim(), done: out.done, what: String(out.what || '').trim(), place: String(out.place || '').trim(), urgency: String(out.urgency || '').trim() };
}
