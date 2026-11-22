import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DAY, nowIso } from '../server/clock.js';
import { purgeOld } from '../server/retention.js';
import { addLead, testApp } from './helpers.js';

// privacy.html#p-keep, the rules in server/retention.js: each kind of data goes on its day, and not a day before.

const NOW = Date.parse('2026-11-22T08:00:00Z');
const ago = (days) => nowIso(NOW - days * DAY);

function customer(db, { phone, status, stoppedDaysAgo = null, createdDaysAgo = 400, paidUntil = null, leadId = null }) {
  return Number(
    db.run(
      'INSERT INTO customers (lead_id, name, business, phone, status, stopped_at, paid_until, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      leadId,
      'שם',
      `עסק ${phone}`,
      phone,
      status,
      stoppedDaysAgo === null ? null : ago(stoppedDaysAgo),
      paidUntil,
      ago(createdDaysAgo),
      ago(createdDaysAgo)
    ).lastInsertRowid
  );
}

test('each kind of data is deleted on its day, and what the tax rules ask for stays', () => {
  const { db } = testApp();
  db.run("INSERT INTO seen (domain, status, at) VALUES ('old.example', 'rejected', ?), ('new.example', 'rejected', ?)", ago(366), ago(300));
  db.run("INSERT INTO demos (phone, started_at, updated_at) VALUES ('972500000001', ?, ?), ('972500000002', ?, ?)", ago(40), ago(31), ago(10), ago(10));

  // A customer who left 13 months ago: gone, with their lead and their chats; the payment record stays.
  const lead = addLead(db);
  db.run("UPDATE leads SET stage = 'closed', closed_why = 'customer' WHERE id = ?", lead.id);
  const left = customer(db, { phone: lead.mobile, status: 'stopped', stoppedDaysAgo: 400, paidUntil: '2025-10-01', leadId: lead.id });
  db.run("INSERT INTO chats (customer_id, caller, opened_at, updated_at) VALUES (?, '972521112233', ?, ?)", left, ago(410), ago(410));
  db.run("INSERT INTO receipts (customer_id, business, source, decision, created_at) VALUES (?, 'עסק', 'manual', 'paid', ?)", left, ago(420));
  // One who left 11 months ago: stays.
  const recent = customer(db, { phone: '972541110000', status: 'stopped', stoppedDaysAgo: 330, paidUntil: '2026-01-01' });
  // Asked to join 7 months ago and never paid: gone. Asked 5 months ago: stays. Paid once: stays.
  const unpaid = customer(db, { phone: '972541110001', status: 'setup', createdDaysAgo: 190 });
  const fresh = customer(db, { phone: '972541110002', status: 'setup', createdDaysAgo: 150 });
  const paid = customer(db, { phone: '972541110003', status: 'setup', createdDaysAgo: 190 });
  db.run("INSERT INTO receipts (customer_id, business, source, decision, created_at) VALUES (?, 'עסק', 'manual', 'paid', ?)", paid, ago(180));
  // A payment record 7 years and a day old: gone.
  db.run("INSERT INTO receipts (customer_id, business, source, decision, created_at) VALUES (NULL, 'ישן', 'manual', 'paid', ?)", ago(7 * 365.25 + 1));

  const out = purgeOld(db, NOW);
  assert.deepEqual(out, { seen: 1, demos: 1, left: 1, unpaid: 1, receipts: 1 });
  assert.deepEqual(db.all('SELECT domain FROM seen').map((r) => r.domain), ['new.example']);
  assert.equal(db.get('SELECT count(*) AS n FROM demos').n, 1);
  assert.deepEqual(db.all('SELECT id FROM customers ORDER BY id').map((r) => r.id), [recent, fresh, paid]);
  assert.equal(db.get('SELECT count(*) AS n FROM leads WHERE id = ?', lead.id).n, 0, 'their lead went with them');
  assert.equal(db.get('SELECT count(*) AS n FROM chats WHERE customer_id = ?', left).n, 0);
  const kept = db.get("SELECT customer_id FROM receipts WHERE business = 'עסק' AND created_at = ?", ago(420));
  assert.ok(kept, 'their payment record stays');
  assert.equal(kept.customer_id, null);
  assert.ok(!db.get('SELECT 1 FROM customers WHERE id = ?', unpaid));
  assert.deepEqual(purgeOld(db, NOW), { seen: 0, demos: 0, left: 0, unpaid: 0, receipts: 0 }, 'nothing twice');
});
