import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { setNow } from '../server/clock.js';
import { createCustomer, getCustomer } from '../server/customers.js';
import { forgetNumberLook, giveNumber, numberOf, numbersTick } from '../server/numbers.js';
import { manualPayment } from '../server/pay.js';
import { TORAN_ENV, fakeToran, testApp } from './helpers.js';

const SUNDAY = Date.parse('2026-11-22T08:00:00Z');
const NENV = { ...TORAN_ENV, TELNYX_API_KEY: 'key', TELNYX_PUBLIC_KEY: 'pub', TELNYX_API: 'https://telnyx.test/v2', TELNYX_CONNECTION_ID: 'conn1', TELNYX_REQUIREMENT_GROUP: 'grp1' };

/** Telnyx, faked: the numbers on the voice app, the ones for sale, and the orders it was sent. */
function fakeTelnyx({ owned = [], available = [] } = {}) {
  const t = { owned: [...owned], available: [...available], orders: [] };
  t.f = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://telnyx.test/v2/phone_numbers?')) {
      assert.match(u, /filter\[connection_id\]=conn1/);
      return Response.json({ data: t.owned.map(([n, status], i) => ({ id: String(i + 1), phone_number: n, status })) });
    }
    if (u.startsWith('https://telnyx.test/v2/available_phone_numbers?')) return Response.json({ data: t.available.map(([n, up, mo]) => ({ phone_number: n, cost_information: { upfront_cost: String(up), monthly_cost: String(mo), currency: 'USD' } })) });
    if (u === 'https://telnyx.test/v2/number_orders' && init.method === 'POST') {
      const body = JSON.parse(init.body);
      t.orders.push(body);
      t.owned.push([body.phone_numbers[0].phone_number, 'requirement-info-under-review']);
      return Response.json({ data: { id: `ord${t.orders.length}`, status: 'pending' } });
    }
    return Response.json({ errors: [{ detail: `unexpected ${u}` }] }, { status: 404 });
  };
  return t;
}

function setup(env = NENV, telnyx = fakeTelnyx()) {
  const toran = fakeToran();
  const ctx = testApp({ env, toranFetch: toran.f });
  ctx.app.telnyxFetch = telnyx.f;
  const customer = (phone = '054-111-2222', business = 'אבי אינסטלציה') => getCustomer(ctx.db, createCustomer(ctx.db, { name: 'אבי כהן', business, trade: 'plumber', phone }).id);
  return { ...ctx, toran, telnyx, customer };
}

beforeEach(() => {
  setNow(SUNDAY);
  forgetNumberLook();
});
afterEach(() => setNow(null));

test('a number we already have and no customer uses is given first, nothing bought', async () => {
  const { app, toran, telnyx, customer } = setup(NENV, fakeTelnyx({ owned: [['+97243763889', 'active']] }));
  const c = customer();
  const r = await giveNumber(app, c);
  assert.deepEqual(r, { ok: true, number: '97243763889', bought: false, active: true });
  assert.equal(getCustomer(app.db, c.id).assistant, '97243763889');
  assert.equal(telnyx.orders.length, 0);
  assert.match(toran.alerts[0].title, /אבי אינסטלציה קיבלו את המספר 04-376-3889/);
  assert.match(toran.alerts[0].body, /קודי ההעברה/);
  // Once they have one, nothing more.
  assert.equal((await giveNumber(app, getCustomer(app.db, c.id))).why, 'not_needed');
});

test('when every number is taken, one is bought with the documents and the voice app, and the admin hears when it works', async () => {
  const { app, db, toran, telnyx, customer } = setup(NENV, fakeTelnyx({ owned: [['+97243763889', 'active']], available: [['+97243763891', 3, 3]] }));
  await giveNumber(app, customer('054-111-2222', 'אבי אינסטלציה'));
  const c = customer('054-333-4444', 'החשמלאי של רמת גן');
  const r = await giveNumber(app, c);
  assert.deepEqual(r, { ok: true, number: '97243763891', bought: true, active: false });
  assert.deepEqual(telnyx.orders[0], { phone_numbers: [{ phone_number: '+97243763891', requirement_group_id: 'grp1' }], connection_id: 'conn1', customer_reference: `alhakav-customer-${c.id}` });
  assert.equal(numberOf(db, getCustomer(db, c.id)).active_at, null);
  assert.match(toran.alerts.at(-1).title, /קנינו מספר להחשמלאי של רמת גן, 04-376-3891/);
  assert.match(toran.alerts.at(-1).body, /3\$ לחודש/);
  // Telnyx still reviewing: nothing; once active: the admin hears.
  await numbersTick(app, SUNDAY + 20 * 60_000);
  assert.equal(toran.alerts.filter((a) => a.key === `number-active:${c.id}`).length, 0);
  telnyx.owned[1][1] = 'active';
  await numbersTick(app, SUNDAY + 40 * 60_000);
  assert.ok(numberOf(db, getCustomer(db, c.id)).active_at);
  assert.match(toran.alerts.at(-1).title, /המספר של החשמלאי של רמת גן פעיל/);
});

test('limits: a few a month and a price ceiling, and the admin hears why', async () => {
  const { app, telnyx, toran, customer } = setup({ ...NENV, NUMBERS_PER_MONTH: '0' }, fakeTelnyx({ available: [['+97243763891', 3, 3]] }));
  const r = await giveNumber(app, customer());
  assert.equal(r.why, 'cap');
  assert.equal(telnyx.orders.length, 0);
  assert.match(toran.alerts.at(-1).title, /לא הצלחנו לתת מספר לאבי אינסטלציה/);
  const dear = setup(NENV, fakeTelnyx({ available: [['+97243763891', 30, 30]] }));
  assert.equal((await giveNumber(dear.app, dear.customer())).why, 'none');
  assert.equal(dear.telnyx.orders.length, 0);
});

test('approving a payment gives the customer their number', async () => {
  const { app, db, customer } = setup(NENV, fakeTelnyx({ owned: [['+97243763889', 'active']] }));
  const c = customer();
  await manualPayment(app, c, '');
  assert.equal(getCustomer(db, c.id).assistant, '97243763889');
});
