import { DAY, now, nowIso } from './clock.js';

// How long each kind of data is kept, the list in privacy.html#p-keep, in one place. The owner, 2026-11-22: "fill these
// gaps both in code and in TOS". Each rule here is on that list; the ones that live elsewhere:
//
//   leads (not customers)       6 months from the last thing that happened with them (leads.js purgeLeads)
//   callers' conversations      90 days from the call, or 30 days after the customer stopped, the earlier (service.js)
//   a transfer's picture        the file 90 days after it came (pay.js)
//   the numbers that asked us to stop    kept while we write to tradespeople (stops), so we never write to them again
//
// and here, once in the half-hourly tick (main.js):
//
//   the sites already checked   12 months from the check; a site found again is read again, and a number in `stops`
//                               never becomes a lead (discover.js)
//   the tries of המוקדן          30 days from the last message of the try
//   a customer who left         12 months after their service stopped: their details, their lead and what is left of
//                               their conversations; the payment records stay
//   someone who asked to join   6 months after they asked, when they never paid (no payment recorded, not free)
//   and never paid
//   payment records             7 years from the payment, as the tax rules ask; the invoices themselves are Morning's

export const KEEP = { seenDays: 365, demoDays: 30, leftDays: 365, unpaidDays: 182, receiptYears: 7 };

/** Deletes what is past its time. Answers how many of each went. */
export function purgeOld(db, at = now()) {
  const before = (days) => nowIso(at - days * DAY);
  const out = { seen: 0, demos: 0, left: 0, unpaid: 0, receipts: 0 };
  db.tx(() => {
    out.seen = db.run('DELETE FROM seen WHERE at < ?', before(KEEP.seenDays)).changes;
    out.demos = db.run('DELETE FROM demos WHERE updated_at < ?', before(KEEP.demoDays)).changes;
    const drop = (c) => {
      if (c.lead_id) db.run('DELETE FROM leads WHERE id = ?', c.lead_id);
      db.run("DELETE FROM leads WHERE mobile = ? AND closed_why = 'customer' AND NOT EXISTS (SELECT 1 FROM customers WHERE phone = leads.mobile AND id != ?)", c.phone, c.id);
      db.run('DELETE FROM customers WHERE id = ?', c.id);
    };
    for (const c of db.all("SELECT id, lead_id, phone FROM customers WHERE status = 'stopped' AND stopped_at < ?", before(KEEP.leftDays))) {
      drop(c);
      out.left++;
    }
    const unpaid = db.all(
      "SELECT id, lead_id, phone FROM customers WHERE status = 'setup' AND paid_until IS NULL AND free = 0 AND created_at < ? AND NOT EXISTS (SELECT 1 FROM receipts WHERE receipts.customer_id = customers.id AND decision = 'paid')",
      before(KEEP.unpaidDays)
    );
    for (const c of unpaid) {
      drop(c);
      out.unpaid++;
    }
    out.receipts = db.run('DELETE FROM receipts WHERE created_at < ?', nowIso(at - KEEP.receiptYears * 365.25 * DAY)).changes;
  });
  return out;
}
