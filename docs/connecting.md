# How a customer connects

Decided with the owner on 2026-11-19: every caller gets a message; each customer gets an assistant number that writes
to their callers and sends the summary to the customer's own WhatsApp; Telnyx provides the numbers; Meta's fees are
in the 149 ₪. The customer's own number only forwards calls and receives summaries: nothing is installed on it or
connected to it.

## How it works

1. **The customer types three codes on their phone, once.** Unanswered calls (after 20 seconds), calls while busy,
   and calls while the phone is off are forwarded by their carrier to their assistant number, an Israeli number at
   Telnyx. Works on every Israeli carrier, iPhone and Android. The forwarded call keeps the caller's number.
2. **The call ends at once** (or after a short recording, if `GREETING_URL` points at one), and the assistant number
   sends the caller a WhatsApp template in the business's name:
   > שלום, כאן העוזר של אבי אינסטלציה. ראינו שהתקשרת ולא הצליחו לענות. מה קרה, ואיפה? הפרטים יעברו אליהם, והם יחזרו
   > אליך כשיתפנו. / לא רלוונטי? אפשר לכתוב "הסר".
3. **When they answer, Claude asks** what happened, where and how urgent, one short question at a time, and never
   quotes a price or a time. Someone describing danger is told to call 102 or 101 first.
4. **The summary goes from the assistant number to the customer's own WhatsApp.** No answer within 20 minutes, and the
   customer gets a note with the number instead; the same for a hidden number, or a number with no WhatsApp.
5. **The customer talks to their assistant** from their own WhatsApp: "לא לשלוח ל־054…" (family, suppliers),
   "לשלוח ל־054…", "לעצור", "להמשיך".

What it does in each case, and why, is at the top of `server/service.js`; the tests in `test/service.test.js` run
every one of them against a fake Telnyx and a fake Claude.

## Set up once

| | What | Where it goes |
|---|---|---|
| Telnyx account | Not a trial account (trial accounts can't use WhatsApp). An API key, and the account's public key (Keys & Credentials) | `TELNYX_API_KEY`, `TELNYX_PUBLIC_KEY` |
| WhatsApp at Telnyx | Mission Control, WhatsApp, the signup: Meta's window creates the WhatsApp Business Account under על הקו's Meta business. Its id | `TELNYX_WABA_ID` |
| A messaging profile | With the webhook URL `https://<domain>/telnyx/webhook`. Its id | `TELNYX_MESSAGING_PROFILE_ID` |
| A Voice API application | With the same webhook URL. Every assistant number is assigned to it | (in Telnyx) |
| Meta business verification | Meta allows 2 numbers until the business is verified, then 20 | (at Meta, takes days) |
| The three templates | `alhakav_caller`, `alhakav_summary`, `alhakav_call_note`, in `docs/whatsapp-templates.md`, submitted as Utility | (at Meta, through Telnyx) |
| Claude | An Anthropic API key | `ANTHROPIC_API_KEY` |

## Each customer (the admin's "לקוחות" page)

1. A lead marked "הפכו ללקוחות" becomes a customer with its name, business and mobile already in; or add one there.
2. **Buy the number** in Telnyx (Israel, voice), assign it to the Voice API application and the messaging profile, and
   paste it on the customer's page.
3. **"לרשום בוואטסאפ".** Meta calls the number and reads a code aloud; the assistant records that call, and its
   recording appears on the page. Listen, type the code, "לאמת".
4. **Send the customer the forwarding codes** shown on the page (they include their number):
   `**61*<number>**20#`, `**67*<number>#`, `**62*<number>#`, then `*#61#` to check. Tell them first that it replaces
   voicemail, and that `##002#` undoes it.
5. **A test:** someone calls the customer and they don't answer. The page shows the call, and the caller gets the
   message. "להפעיל" turns the assistant on (until then a forwarded call gets no message).
6. Payment: bank transfer and a Morning invoice, as openfrequency-accounts does it (not built here yet).

## Check on the first number

These could not be confirmed from Telnyx's or Meta's documents, so the first customer is also the test:

- **WhatsApp on an Israeli Telnyx number.** Telnyx lists WhatsApp in 180+ countries but no list of which numbers.
  If an Israeli number can't be registered, the fallback is Twilio, which also does voice and WhatsApp on its numbers.
- **The caller's number on a forwarded call** arrives in `from` (Bezeq says the caller's number is kept; no Israeli
  carrier says it isn't). The test call shows it.
- **The template's category.** Meta may class "we saw you called" as Marketing ($0.0353 a message in Israel) rather
  than Utility ($0.0053), since the caller didn't ask for WhatsApp. Either way the cost is in the price; a template
  that people block or report would lower the assistant numbers' rating, so "הסר" stops every message at once.
- **More than 20 customers** needs Meta to raise the number limit, or על הקו becoming a Meta Tech Provider.

## What it costs, per customer, per month

At 100 missed calls, estimated from the published prices (Telnyx and Meta in dollars):

| | |
|---|---|
| The assistant number | $3 (Telnyx, Israel local) |
| Telnyx per message ($0.004), about 400 messages in and out | about $1.60 |
| Meta: the first message and the summary, 100 each | $1.06 as Utility, $7.06 if both were Marketing |
| Claude Opus 5.5, about 3 short turns a conversation | about $3 to $4 |
| **Total** | **about $9 to $16**, against 149 ₪ |

Replies inside the 24 hours are within the 1,000 free service messages Meta gives each number a month.

## Sources

Telnyx WhatsApp and voice (read 2026-11-19): https://developers.telnyx.com/docs/messaging/whatsapp/embedded-signup ;
https://developers.telnyx.com/docs/messaging/whatsapp/send-messages.md ;
https://developers.telnyx.com/docs/messaging/messages/receiving-webhooks.md (Ed25519) ;
https://developers.telnyx.com/api-reference/call-commands/answer-call.md ; https://telnyx.com/pricing/whatsapp ;
https://telnyx.com/phone-numbers/israel. Meta's number limits: https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers/ ;
templates and opt-in: https://developers.facebook.com/docs/whatsapp/updates-to-pricing/new-template-guidelines ;
prices in Israel: https://developers.facebook.com/docs/whatsapp/pricing. Forwarding codes and caller ID: Pelephone,
Cellcom, Partner and Bezeq's support pages, and https://www.exm.co.il/kb/virtual-numbers/call-forward/cellcom.html.
