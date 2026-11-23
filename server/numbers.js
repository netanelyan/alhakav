import { adminLink, alertOwner } from './alerts.js';
import { MINUTE, israelParts, now, nowIso } from './clock.js';
import { TC } from './copy.js';
import { num } from './env.js';
import { local, normalize } from './phones.js';
import { sendSetup } from './setup.js';
import { availableNumbers, numbersOn, orderNumber, requirementGroup, telnyxSettings } from './telnyx.js';

// A customer's own number at Telnyx (docs/connecting.md), the one their unanswered calls are forwarded to, given when
// the admin approves their payment (the owner, 2026-11-21: "a number should be bought when i approve the payment").
//
//   first   a number already on the voice app that no customer has (one bought by hand, or given back by one who left)
//   else    a new Israeli local number is bought onto the voice app (TELNYX_CONNECTION_ID) with the requirement group
//           (TELNYX_REQUIREMENT_GROUP: our business's documents, which Telnyx asks of every Israeli number), at most
//           NUMBERS_PER_MONTH (5) in a calendar month and NUMBER_MAX_USD ($5) up front and a month
//   then    it is the customer's at once; the admin hears what happened, and again when Telnyx made a new one active
//           (its review can take a day or more); the forwarding codes go to the customer by themselves the moment
//           the number works (setup.js)
//
// Also from the customer's page ("לקנות מספר"), for a customer who does not pay (free) or after a failure. Nothing here
// throws to its caller.

export function numberSettings(env) {
  const t = telnyxSettings(env);
  const s = {
    connection: String(env.TELNYX_CONNECTION_ID || '').trim(),
    group: String(env.TELNYX_REQUIREMENT_GROUP || '').trim(),
    perMonth: num(env.NUMBERS_PER_MONTH, 5),
    maxUsd: num(env.NUMBER_MAX_USD, 5),
  };
  return { ...s, t, ready: Boolean(t.key && s.connection && s.group) };
}

const busy = new Set();
const page = (env, c) => adminLink(env, `/admin/customers/${c.id}#setup`);
const taken = (db, digits) => Boolean(db.get('SELECT 1 FROM customers WHERE assistant = ?', digits));

/** Give customer c a number. Answers { ok, number, bought, active } or { ok: false, why, detail }. */
export async function giveNumber(app, customer) {
  const { db, env } = app;
  const c = db.get('SELECT * FROM customers WHERE id = ?', customer.id);
  if (!c || c.assistant || c.status === 'stopped') return { ok: false, why: 'not_needed' };
  const s = numberSettings(env);
  if (!s.ready) {
    await alertOwner(app, `number:${c.id}`, TC.numbers.alert.failed(c.business), `${TC.numbers.why.setup}\n${page(env, c)}`, 60);
    return { ok: false, why: 'setup' };
  }
  if (busy.has(c.id)) return { ok: false, why: 'busy' };
  busy.add(c.id);
  try {
    const ours = await numbersOn(s.t, app.telnyxFetch, s.connection);
    const free = ours.find((n) => {
      const d = normalize(n.number);
      return d && !taken(db, d);
    });
    let pick;
    if (free) {
      pick = { digits: normalize(free.number), active: free.status === 'active', bought: false };
    } else {
      const month = new Date(now()).toISOString().slice(0, 7);
      const n = db.get('SELECT count(*) AS n FROM numbers WHERE substr(ordered_at, 1, 7) = ?', month).n;
      if (n >= s.perMonth) return await failed(app, c, 'cap', TC.numbers.why.cap(s.perMonth));
      const found = (await availableNumbers(s.t, app.telnyxFetch)).find((x) => normalize(x.number) && !taken(db, normalize(x.number)) && x.upfront <= s.maxUsd && x.monthly <= s.maxUsd);
      if (!found) return await failed(app, c, 'none', TC.numbers.why.none(s.maxUsd));
      const order = await orderNumber(s.t, app.telnyxFetch, found.number, s.connection, s.group, `alhakav-customer-${c.id}`);
      db.run('INSERT INTO numbers (number, order_id, customer_id, monthly_usd, ordered_at) VALUES (?, ?, ?, ?, ?)', normalize(found.number), order.id || null, c.id, found.monthly, nowIso());
      pick = { digits: normalize(found.number), active: false, bought: true, monthly: found.monthly };
      app.log(`[numbers] bought ${local(pick.digits)} for customer ${c.id} (order ${order.id}, ${order.status})`);
    }
    const set = db.run('UPDATE customers SET assistant = ?, updated_at = ? WHERE id = ? AND assistant IS NULL', pick.digits, nowIso(), c.id);
    if (Number(set.changes) !== 1) return { ok: false, why: 'not_needed' };
    if (pick.active) db.run('UPDATE numbers SET active_at = coalesce(active_at, ?) WHERE number = ?', nowIso(), pick.digits);
    const title = pick.bought ? TC.numbers.alert.bought(c.business, local(pick.digits)) : TC.numbers.alert.given(c.business, local(pick.digits));
    const body = `${pick.active ? TC.numbers.alert.ready : TC.numbers.alert.review(pick.monthly)}\n${page(env, c)}`;
    await alertOwner(app, `number:${c.id}`, title, body, 1);
    // A number that works already: the customer gets the codes now (setup.js).
    if (pick.active) await sendSetup(app, { ...c, assistant: pick.digits });
    return { ok: true, number: pick.digits, bought: pick.bought, active: pick.active };
  } catch (e) {
    app.log(`[numbers] customer ${c.id}: ${e.message}`);
    return await failed(app, c, 'failed', e.message);
  } finally {
    busy.delete(c.id);
  }
}

async function failed(app, c, why, detail) {
  await alertOwner(app, `number:${c.id}`, TC.numbers.alert.failed(c.business), `${detail}\n${TC.numbers.alert.retry}\n${page(app.env, c)}`, 1);
  return { ok: false, why, detail };
}

/** Where a customer's new number stands: null when it is not one we bought and is not waiting. */
export const numberOf = (db, c) => (c.assistant ? db.get('SELECT * FROM numbers WHERE number = ?', c.assistant) : null);

let lastLook = 0;
/**
 * Once a minute from main.js: every 15 minutes, while a bought number waits for Telnyx, see whether it is active. Not
 * from 21:00 to 08:00: the codes go to the customer the moment it is, and a message at 3am wakes a tradesperson. The
 * morning is still within the 24 hours they were promised.
 */
export async function numbersTick(app, at = now()) {
  const waiting = app.db.all('SELECT * FROM numbers WHERE active_at IS NULL');
  const { hour } = israelParts(at);
  if (!waiting.length || at - lastLook < 15 * MINUTE || hour < 8 || hour >= 21) return;
  lastLook = at;
  const s = numberSettings(app.env);
  if (!s.ready) return;
  const ours = await numbersOn(s.t, app.telnyxFetch, s.connection);
  for (const w of waiting) {
    const n = ours.find((x) => normalize(x.number) === w.number);
    if (!n || n.status !== 'active') continue;
    app.db.run('UPDATE numbers SET active_at = ? WHERE id = ?', nowIso(at), w.id);
    const c = w.customer_id && app.db.get('SELECT * FROM customers WHERE id = ?', w.customer_id);
    if (c && c.assistant === w.number) {
      await alertOwner(app, `number-active:${c.id}`, TC.numbers.alert.active(c.business, local(w.number)), `${TC.numbers.alert.ready}\n${page(app.env, c)}`, 1);
      await sendSetup(app, c);
    }
  }
}

export const forgetNumberLook = () => {
  lastLook = 0;
  lastGroupLook = 0;
};

let lastGroupLook = 0;
/**
 * Once a minute from main.js: every 30 minutes, Telnyx's review of our documents (TELNYX_REQUIREMENT_GROUP), which
 * every new Israeli number waits for. The owner hears each change: approved, not approved with what and why, or
 * anything else. The first look only remembers, unless it is approved already. Answers the status, or null.
 */
export async function groupTick(app, at = now()) {
  if (at - lastGroupLook < 30 * MINUTE) return null;
  lastGroupLook = at;
  const s = numberSettings(app.env);
  if (!s.ready) return null;
  const g = await requirementGroup(s.t, app.telnyxFetch, s.group);
  const was = app.db.kv('telnyx:group');
  if (!g.status || g.status === was) return g.status || null;
  app.db.kv('telnyx:group', g.status);
  const G = TC.numbers.group;
  if (g.status === 'approved') await alertOwner(app, 'telnyx-group', G.approved, G.approvedBody, 1);
  else if (!was) return g.status;
  else if (['declined', 'rejected', 'unapproved'].includes(g.status)) {
    const lines = g.requirements.filter((r) => r.status !== 'approved').map((r) => G.part(r.type, r.status, r.reason));
    await alertOwner(app, 'telnyx-group', G.declined, G.declinedBody(lines), 1);
  } else await alertOwner(app, 'telnyx-group', G.other(g.status), G.otherBody, 1);
  app.log(`[numbers] Telnyx's review of our documents: ${was || '-'} -> ${g.status}`);
  return g.status;
}
