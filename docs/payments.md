# Paying

What terms.html promises, built the way openfrequency takes payments over WhatsApp: 149 ₪ a month before VAT
(175.82 ₪ with it), paid ahead for each month by bank transfer; the amount and the transfer details go to the customer
on WhatsApp; they send back a screenshot or a PDF of the transfer; the admin checks the bank and records it; Morning
issues the invoice-receipt. A payment that has not come within 72 hours after the paid month ends stops the assistant
until it comes. A payment for the current month or an earlier one is never refunded, not even in part (terms.html,
"החזרים"). **Nothing records a payment by itself, and nothing moves money: only the admin's press records one.**

All of it is on the business number (the one the lead desk writes from, `META_*`), not on the assistant numbers: it is
על הקו talking to its customer, and Meta's API can fetch the picture they send there.

## Where a customer stands

`server/billing.js`, `billingOf()`. Days are Israel's calendar days, and a paid month includes its first and last day
(22.11 to 21.12).

| State | When | The assistant | What is owed |
|---|---|---|---|
| new | never paid | does not write to callers | the first month, from the day it is recorded |
| paid | today is in a paid month | works | nothing; in the month's last 7 days, the next month (it may be paid ahead) |
| grace | up to 3 days after the paid month (the 72 hours) | works | the next month, from the day after the paid one |
| lapsed | after that | does not write to callers | a new month, from the day it is recorded |
| free | "בלי תשלום" ticked (a pilot) | works | nothing |
| ending | "להפסיק בסוף החודש ששולם" pressed | works until that day | nothing; the next day the customer is stopped |

A test call from the customer's own number always answers, paid or not, so setup can be checked before the first
payment.

## The flow

1. **The request.** On the customer's page, the payment card shows what is owed and the exact message, and
   "לשלוח בקשת תשלום בוואטסאפ" sends it. While the customer wrote to the business number in the last 24 hours it goes
   as plain text, otherwise as the template `alhakav_payment` (docs/whatsapp-templates.md). The reminders go by
   themselves (below).
2. **The picture.** An image or a PDF from the customer's own number while something is owed is a receipt: fetched from
   Meta (5 MB at most, checked by its first bytes), kept with what was owed at that moment, and the customer gets
   "קיבלנו את האישור, תודה. נבדוק מול הבנק ונעדכן כאן." The very same file again is the same receipt. At most 5 in 24
   hours. A picture while nothing is owed is just a message in their chat.
3. **The check.** The customers' page lists "אישורי העברה שמחכים". A receipt's page shows the picture, what was owed when
   it came and what is owed today, and two buttons: **"התשלום הגיע"** records the month and **"לא הגיע"** records nothing
   and tells nobody (use it also for a picture that is not a transfer, or a second picture of a transfer already
   recorded).
4. **The invoice.** "התשלום הגיע" then asks Morning for a חשבונית מס/קבלה (below), and the customer gets "התשלום הגיע,
   תודה. העוזר של … משולם עד …" with the invoice's link, when they wrote in the last 24 hours.

**"התקבל תשלום"** on the customer's page records the owed month with no picture (a payment that came some other way, or
from someone else's phone). It is kept as a receipt already marked paid, so its invoice is issued the same way.

**Never twice.** Both buttons carry the paid-until day the page showed; if it changed meanwhile (another receipt, the
other button, a page left open), nothing is recorded and the page says the payment was already recorded. A receipt is
decided once. A receipt checked days after it came still records the month it asked for, so a slow check never costs
the customer days.

## The reminders

From the business number, once each per paid month, never in a quiet hour (20:00 to 09:00, Shabbat and holidays), and
none while a receipt waits for the admin:

| | When | Says |
|---|---|---|
| soon | the paid month's last 3 days | paid until X; this is the payment for the next month, from … to … |
| due | 1 or 2 days after it | the paid month ended; the assistant works until the end of the 72 hours, then stops |
| last | the last day of the 72 hours | the assistant works until the end of today |
| stopped | 4 to 10 days after it | the assistant is stopped until the payment comes |

None to a number that asked us to stop writing (`stops`): the admin's button says so too. The page lists what went.

## The invoice-receipt in Morning

`server/morning.js`, ported from openfrequency-accounts. Set `MORNING_CLIENT_ID` and `MORNING_CLIENT_SECRET` (the
business's API keys in Morning, on a plan that includes the API; `MORNING_ENV=sandbox` for Morning's sandbox). Unset,
payments are recorded as before and the receipt's page says the invoice was not issued.

1. A token from Morning's identity service, kept in memory for its hour.
2. `GET /documents/info?type=320`: when Morning says the business is VAT-exempt, or its VAT rate is not 18%, nothing is
   issued and the page says what to fix.
3. `POST /documents`: type 320, Hebrew, shekels; the client is the customer's "השם בחשבונית" (else the business's name),
   with their עוסק number, address and email when the page has them (Morning emails it to them with its PDF); one row,
   "על הקו, 22.11.2026 עד 21.12.2026", 149 ₪ with VAT added (vatType 0); one payment, a bank transfer (type 4), of
   175.82 ₪.

The payment is recorded first, always: an invoice that fails never holds it up, and the receipt's page shows Morning's
code and words and "להפיק חשבונית שוב". One receipt is claimed before Morning is asked, so a double press never makes
two documents. Read with the business's keys on 2026-11-21: `/documents/info` answers `vatRate` 0.18 and `exemption`
false. UNVERIFIED until the first invoice, as in openfrequency: the error body's field names, and the client's `taxId`
and `address` field names.

## Settings

| Setting | |
|---|---|
| `PAYMENT_DETAILS` | The transfer details in one line, as the customer reads them: "בנק הפועלים (12), סניף 345, חשבון 678901, על שם ישראל ישראלי". Unset, no payment message goes. |
| `TEMPLATE_PAYMENT` | The approved template's name, `alhakav_payment` by default. |
| `MORNING_CLIENT_ID`, `MORNING_CLIENT_SECRET`, `MORNING_ENV` | Morning, above. |

A customer's price is on their page ("מחיר לחודש, לפני מע״מ", 149 by default), with the invoice details.

## What is kept

As privacy.html says: the picture is deleted 90 days after it came (`RECEIPT_FILE_DAYS`); the receipt's row stays as
the record of the payment (who sent it, when, what was owed, what was recorded, the invoice's number). Deleting a
customer deletes their pictures at once and keeps the rows, for the 7 years the tax law asks.
