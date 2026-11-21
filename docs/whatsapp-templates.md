# WhatsApp templates

A business can write first to someone who has not written to it in the last 24 hours only with a template Meta
approved. The outreach to tradespeople uses two, both **Marketing**, in **Hebrew (he)**: the first message carries
their own page as a link button (docs/demo.md), says who writes, and carries the way out as a button. docs/autopilot.md
says why the first message is an offer from the start, and what follows from that.

The last line of each body identifies who writes, as section 30A asks of an advertiser: the business name, the owner's
full name and the address. That line is one of the few places the owner's details appear, so it is never written in
this repo: it lives only in `SENDER_LINE` on the server, and the template submitted to Meta carries it exactly, so the
admin page shows what the tradesperson will read.

Where they go: a WhatsApp Business Account named על הקו in the verified HanutHashofet portfolio, created with the
business number itself (Meta's "Create a WhatsApp account" asks for the number and verifies it in the same step), so
the number comes first.

Meta's rules these follow: the body does not start or end with a variable, a link button's variable is the end of its
address, and the link comes before the quick reply. The link's address is fixed when Meta approves the template, so it
is the site's real domain (`SITE_URL`); a new domain means submitting both again under new names and setting
`TEMPLATE_FIRST` and `TEMPLATE_REMINDER`.

## alhakav_page (the first message)

| | |
|---|---|
| Name | `alhakav_page` (or set `TEMPLATE_FIRST`) |
| Category | Marketing |
| Language | Hebrew (he) |
| Buttons | a link, `לראות את הדף שלכם`, to `<SITE_URL>/p/{{1}}`; then a quick reply, `לא, תודה` |
| Variables (sample) | the body's `{{1}}` = `אצל אבי אינסטלציה`; the link's `{{1}}` = `abcdefgh23`, the page's code |

```
שלום, כאן על הקו. כשאתם באמצע עבודה ולא עונים, מי שהתקשר מקבל מאיתנו הודעה בוואטסאפ בשם העסק, ואתם מקבלים סיכום של מה שהוא צריך.

הכנו דף קצר שמראה איך זה ייראה {{1}}. אפשר גם לנסות שם על עצמכם, לוקח דקה.

לא רלוונטי? לוחצים "לא, תודה" ולא נכתוב שוב.

[שם העסק], [שם מלא], [כתובת].
```

## alhakav_page_reminder (the one reminder, four days later, only by the admin)

| | |
|---|---|
| Name | `alhakav_page_reminder` (or set `TEMPLATE_REMINDER`) |
| Category | Marketing |
| Language | Hebrew (he) |
| Buttons | the same two |
| Variables (sample) | the same |

```
שלום שוב, כאן על הקו. לפני כמה ימים שלחנו לכם דף שמראה איך זה ייראה {{1}}: מי שמתקשר ולא מקבל מענה מקבל מאיתנו הודעה בוואטסאפ, ואתם מקבלים סיכום.

זו ההודעה האחרונה שלנו בנושא. לא רלוונטי? לוחצים "לא, תודה" ולא נכתוב שוב.

[שם העסק], [שם מלא], [כתובת].
```

## Submitting them

With the API, a system user token and the WhatsApp Business Account's id (`META_WABA_ID`), on the server, where
`SENDER_LINE` is, so the owner's details are never typed anywhere else:

```sh
set -a; . /etc/alhakav/alhakav.env; set +a
body1="שלום, כאן על הקו. כשאתם באמצע עבודה ולא עונים, מי שהתקשר מקבל מאיתנו הודעה בוואטסאפ בשם העסק, ואתם מקבלים סיכום של מה שהוא צריך.

הכנו דף קצר שמראה איך זה ייראה {{1}}. אפשר גם לנסות שם על עצמכם, לוקח דקה.

לא רלוונטי? לוחצים \"לא, תודה\" ולא נכתוב שוב.

$SENDER_LINE"

jq -n --arg body "$body1" --arg site "${SITE_URL%/}" '{name: "alhakav_page", language: "he", category: "MARKETING",
  components: [{type: "BODY", text: $body, example: {body_text: [["אצל אבי אינסטלציה"]]}},
               {type: "BUTTONS", buttons: [
                 {type: "URL", text: "לראות את הדף שלכם", url: ($site + "/p/{{1}}"), example: [($site + "/p/abcdefgh23")]},
                 {type: "QUICK_REPLY", text: "לא, תודה"}]}]}' |
curl -sS -X POST "https://graph.facebook.com/v23.0/$META_WABA_ID/message_templates" \
  -H "Authorization: Bearer $META_TOKEN" -H "Content-Type: application/json" --data @-
```

The same for `alhakav_page_reminder` with its body. Until Meta approves the first, the scheduled task sends nothing
(`template_pending`), and a send from the admin answers error 132001, which the lead's page explains.

The first templates, `alhakav_ask` and `alhakav_ask_reminder` (a question first, with "כן, שלחו"), stay on the account
for the leads that got them; "כן, שלחו" still brings their page.

## What happens after

- **לראות את הדף שלכם**: their page (docs/demo.md). The owner hears when they open it, and when they try המוקדן.
- **כן** typed (or the old "כן, שלחו" button): their page again at once, with the price, as plain text (`MSG.pitch`),
  since they just wrote to us. The lead moves to "בשיחה".
- **לא, תודה** (or "לא", "הסר", "די" in any short form, at any time): the number goes into `stops`, one line says it
  was removed, the lead closes, and no message goes to it again.
- Anything else they write: Toran's sales bot answers (docs/toran.md), and for 24 hours the admin can answer from the
  lead's page too.

## המוקדן's number (the service itself)

Three **Utility** templates on על הקו's own WhatsApp Business Account (`META_WABA_ID`), the one both numbers are on:
templates belong to the account, so המוקדן's number (`ASSIST_PHONE_ID`) sends them. Submitted with the API on
2026-11-21. The bodies are the same text `server/copy.js` (`SVC`) builds, written for a tradesperson who reads them on
a job: plain words, no office language. A variable's value never has a line break in it (Meta refuses that).

### alhakav_caller, to the caller, as their call ends

| | |
|---|---|
| Category | Utility |
| Variables (sample) | `{{1}}` = `אבי אינסטלציה` |

```
שלום, כאן העוזר של {{1}}. ראינו שהתקשרת ולא הצליחו לענות. מה קרה, ואיפה? הפרטים יעברו אליהם, והם יחזרו אליך כשיתפנו.

לא רלוונטי? אפשר לכתוב "הסר".
```

### alhakav_summary, to the customer

| | |
|---|---|
| Category | Utility |
| Variables (sample) | `{{1}}` = `10:41`, `{{2}}` = `נזילה חזקה מתחת לכיור`, `{{3}}` = `הרצל 15, אשדוד, קומה 3`, `{{4}}` = `דחוף, המים זורמים`, `{{5}}` = `054-123-4567` |

```
התקשרו אליכם ב־{{1}} ולא עניתם. זה מה שצריך:

מה: {{2}}
איפה: {{3}}
כמה דחוף: {{4}}
טלפון: {{5}}

אפשר לחזור בטלפון או בוואטסאפ.
```

### alhakav_call_note, to the customer, when there is no conversation to sum up

| | |
|---|---|
| Category | Utility |
| Variables (sample) | `{{1}}` = `מ־054-123-4567`, `{{2}}` = `10:41`, `{{3}}` = `שלחנו הודעה בוואטסאפ ועוד אין תשובה.` |

```
התקשרו אליכם {{1}} ב־{{2}} ולא עניתם.
{{3}}

נעדכן כשיהיה משהו חדש.
```

While the customer wrote to their assistant in the last 24 hours, the summary and the note go as plain text instead,
with the same words.

## The payment message (the business number)

One more **Utility** template, on the business number's WhatsApp Business Account (`META_WABA_ID`, the same as the
outreach templates), for the payment requests and reminders (docs/payments.md). Inside the 24 hours after the
customer's last message the same words go as plain text.

### alhakav_payment

| | |
|---|---|
| Category | Utility |
| Language | Hebrew (he) |
| Buttons | none |
| Variables (sample) | `{{1}}` = `העוזר של אבי אינסטלציה משולם עד 24.11.2026. זה התשלום על החודש הבא, מ־25.11.2026 עד 24.12.2026.`, `{{2}}` = `175.82`, `{{3}}` = `בנק הפועלים (12), סניף 345, חשבון 678901, על שם ישראל ישראלי` |

```
שלום, כאן על הקו. {{1}}

לתשלום: {{2}} ₪ כולל מע״מ, בהעברה בנקאית: {{3}}

אחרי ההעברה שולחים כאן צילום מסך או PDF של האישור, ונעדכן כשהתשלום הגיע.
```

`{{1}}` is one of five lines in `server/copy.js` (`PAY.lines`): the first month, the next month, the month ended, the
last day, stopped. `{{3}}` is `PAYMENT_DETAILS`.
