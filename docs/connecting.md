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
6. **Payment** (docs/payments.md): fill in the invoice details on the customer's page, press "לשלוח בקשת תשלום
   בוואטסאפ", and when their transfer's picture comes, check the bank and press "התשלום הגיע". The assistant writes to
   callers only once the first month is recorded (or "בלי תשלום" is ticked, for a pilot).

## Check on the first number

What the documents say (read 2026-11-21), and what only the first customer can show:

- **WhatsApp on an Israeli Telnyx number: likely.** Telnyx's WhatsApp FAQ takes landline, mobile and toll-free
  numbers and names no country it excludes; Meta takes VoIP and fixed lines whose code comes by voice ("Standard";
  by SMS to VoIP is "Not Recommended"), provided the number takes calls from abroad and no IVR stands in the way.
  Telnyx's Israeli local numbers need a business registration certificate, a use-case description and a proof of
  address under 3 months old; its Israeli mobile numbers only a name and an email. No one reports a Telnyx +972 number
  registered, so the first number is the test. If it fails, Twilio sells Israeli local numbers ($5.50 a month) that
  can be WhatsApp senders by voice code.
- **The caller's number on a forwarded call: likely kept.** Israeli carriers' forwarding (Pelephone, Partner,
  Cellcom, HOT Mobile, Bezeq and others) shows the caller's number, not the forwarding phone's, and products like
  ITD's WhatsApp router are built on it. Golan and some prepaid SIMs block forwarding abroad. Whether Telnyx's Israeli
  supplier passes it on is the test call. Telnyx's `call.initiated` carries the caller in `from`, and a `Diversion`
  or `History-Info` header in `sip_headers` (e.g. `reason=user-busy`) when the network sends one; `to` already says
  whose assistant it is.
- **The template's category: likely Utility, at real risk of Marketing.** Utility must be non-promotional and
  specific to the user; Meta's "continue a conversation" case ("we are following up on your call...") is the closest,
  but says the move to WhatsApp should be one the user asked for. Since April 2025 a Utility template Meta reads as
  Marketing is approved as Marketing, and can be recategorized later with a day's notice (the
  `template_category_update` webhook; 60 days to appeal). In Israel since 2026-10-01: Marketing $0.0353, Utility
  $0.0053, and Utility is no longer free inside the 24 hours; a phone call opens no 24 hours, so the first message is
  always paid. A `GREETING_URL` that says "נמשיך בוואטסאפ" before the call ends makes the case for Utility stronger.
  Either way the cost is in the price; a template that people block or report would lower the assistant numbers'
  rating, so "הסר" stops every message at once.
- **More than 20 customers** needs Meta to raise the number limit, or על הקו becoming a Meta Tech Provider.

## What it costs, per customer, per month

At 100 missed calls, estimated from the published prices (Telnyx and Meta in dollars):

| | |
|---|---|
| The assistant number | $3 (Telnyx, Israel local) |
| Telnyx per message ($0.004), about 400 messages in and out | about $1.60 |
| Meta: the first message and the summary, 100 each | $1.06 as Utility, $7.06 if both were Marketing |
| Claude Sonnet 5.5, about 3 short turns a conversation | about $1.50 to $2 |
| **Total** | **about $7 to $14**, against 149 ₪ |

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

The checks above (read 2026-11-21): https://support.telnyx.com/en/articles/13986488-whatsapp-faq ;
https://support.telnyx.com/en/articles/5466651-israel-did-requirements ;
https://www.twilio.com/docs/whatsapp/register-senders-using-api.md ; https://www.twilio.com/en-us/voice/pricing/il ;
https://www.ice.co.il/digital-140/news/article/836530 (forwarding keeps the caller's number) ;
https://www.mako.co.il/nexter-cellular/apps/Article-c77c83875d1a461006.htm ;
https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-categorization ;
https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing.
