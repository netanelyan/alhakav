import { DAY, israelDate } from './clock.js';

// What a customer owes, and whether their assistant works (terms.html#t-price): 149 ₪ a month before VAT, paid ahead
// for each month by bank transfer. A payment that has not come within 72 hours after the paid month ends stops the
// assistant until it comes. openfrequency-accounts' billing.js and subscriptions.js, for one product with no setup fee.
//
//   new      never paid: the first month is owed, from the day it is recorded; the assistant waits for it
//   paid     today is in a paid month; in its last AHEAD_DAYS (7) the next month may be paid already
//   grace    the paid month ended, and it is within GRACE_DAYS (the 72 hours): the assistant still works, and the next
//            month is owed from the day after the paid one, so the grace days are part of it
//   lapsed   the grace is over: the assistant is stopped, and a payment starts a new month on the day it is recorded
//   free     no charge (a pilot): never owed, never stopped
//   ending   they asked to stop: the paid month runs out (ends_on) and nothing more is owed; then ended
//   ended    stopped
//
// Days are Israel's calendar days, YYYY-MM-DD, and a paid month includes both its first and its last day.

export const VAT = 0.18;
export const PRICE = 149;
export const GRACE_DAYS = 3;
export const AHEAD_DAYS = 7;

const toUtc = (d) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
const fromUtc = (t) => new Date(t).toISOString().slice(0, 10);

export const addDays = (d, n) => fromUtc(toUtc(d) + n * DAY);
export const daysBetween = (a, b) => Math.round((toUtc(b) - toUtc(a)) / DAY);

/** The same day a month on, or the month's last day when it has no such day (31 January to 28 or 29 February). */
export function addMonths(d, n = 1) {
  const y = +d.slice(0, 4);
  const m = +d.slice(5, 7) - 1 + n;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return fromUtc(Date.UTC(y, m, Math.min(+d.slice(8, 10), last)));
}

/** A month from `from`: 22.11 to 21.12. */
export const monthFrom = (from) => ({ from, until: addDays(addMonths(from, 1), -1) });

const round2 = (n) => Math.round(n * 100) / 100;

/** The month's price: { net, vat, total }, VAT added to the price as recorded and rounded to the agora. */
export function priceOf(c) {
  const net = round2(Number(c.price ?? PRICE));
  const total = round2(net * (1 + VAT));
  return { net, vat: round2(total - net), total };
}

/**
 * Where a customer stands on `today`: { state, on, owed, paidUntil, graceUntil, endsOn, left }. `on`: the assistant
 * writes to callers. `owed`: the month a payment would record now, { from, until, net, vat, total }, or null.
 */
export function billingOf(c, today = israelDate()) {
  const paidUntil = c.paid_until || null;
  const base = { paidUntil, graceUntil: paidUntil ? addDays(paidUntil, GRACE_DAYS) : null, endsOn: c.ends_on || null, left: null };
  const owe = (from) => ({ ...monthFrom(from), ...priceOf(c) });
  if (c.status === 'stopped') return { ...base, state: 'ended', on: false, owed: null };
  if (c.free) return { ...base, state: 'free', on: true, owed: null };
  if (c.ends_on) return today <= c.ends_on ? { ...base, state: 'ending', on: true, owed: null } : { ...base, state: 'ended', on: false, owed: null };
  if (!paidUntil) return { ...base, state: 'new', on: false, owed: owe(today) };
  if (today <= paidUntil) {
    const left = daysBetween(today, paidUntil);
    return { ...base, state: 'paid', on: true, left, owed: left < AHEAD_DAYS ? owe(addDays(paidUntil, 1)) : null };
  }
  if (today <= base.graceUntil) return { ...base, state: 'grace', on: true, owed: owe(addDays(paidUntil, 1)) };
  return { ...base, state: 'lapsed', on: false, owed: owe(today) };
}

/** "21.11.2026" */
export const dateHe = (d) => (d ? `${+d.slice(8, 10)}.${+d.slice(5, 7)}.${d.slice(0, 4)}` : '');

/** "175.82", "1,490" */
export const money = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: Number(n) % 1 ? 2 : 0, maximumFractionDigits: 2 });
