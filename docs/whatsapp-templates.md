# WhatsApp templates

A business can write first to someone who has not written to it in the last 24 hours only with a template Meta
approved. על הקו uses two, both **Marketing**, in **Hebrew (he)**, the same shape as openfrequency's
`openfrequency_ask`: they ask before sending anything, say who writes, and carry the way out as a button.

Before submitting, replace the last line of each body with the real identification line: the business name, your full
name, the address and the site. Put the exact same line in `SENDER_LINE` in `private/.env`, so the admin page shows
what the tradesperson will read.

Meta's rules these follow: the body does not start or end with a variable, and quick replies are the only buttons.

## alhakav_ask (the first message)

| | |
|---|---|
| Name | `alhakav_ask` (or set `TEMPLATE_FIRST`) |
| Category | Marketing |
| Language | Hebrew (he) |
| Buttons | two quick replies: `כן, שלחו`, then `לא, תודה` |
| Variable (sample) | `{{1}}` = `אצל אבי אינסטלציה` |

```
שלום, כאן על הקו. כשאתם באמצע עבודה ולא עונים לטלפון, אנחנו שולחים למי שהתקשר הודעה בוואטסאפ, מבררים מה הוא צריך, ושולחים לכם סיכום.

אפשר לשלוח לכם הסבר קצר איך זה יעבוד {{1}}?

לא מעוניינים? לוחצים "לא, תודה" ולא נכתוב שוב.

[שם העסק], [שם מלא], [כתובת]. [אתר]
```

## alhakav_ask_reminder (the one reminder, four days later)

| | |
|---|---|
| Name | `alhakav_ask_reminder` (or set `TEMPLATE_REMINDER`) |
| Category | Marketing |
| Language | Hebrew (he) |
| Buttons | two quick replies: `כן, שלחו`, then `לא, תודה` |
| Variable (sample) | `{{1}}` = `אצל אבי אינסטלציה` |

```
שלום שוב, כאן על הקו. לפני כמה ימים שאלנו אם אפשר לשלוח לכם הסבר קצר איך זה יעבוד {{1}}: מי שמתקשר ולא מקבל מענה מקבל מאיתנו הודעה בוואטסאפ, ואתם מקבלים סיכום.

זו ההודעה האחרונה שלנו בנושא. לוחצים "כן, שלחו" ונשלח, או "לא, תודה" ולא נכתוב שוב.

[שם העסק], [שם מלא], [כתובת]. [אתר]
```

## Submitting them

In WhatsApp Manager (Account tools, Message templates), or with the API, using a system user token and your WhatsApp
Business Account id (`META_WABA_ID`). After filling in the last line, from a shell with `jq` installed:

```sh
body1='שלום, כאן על הקו. כשאתם באמצע עבודה ולא עונים לטלפון, אנחנו שולחים למי שהתקשר הודעה בוואטסאפ, מבררים מה הוא צריך, ושולחים לכם סיכום.

אפשר לשלוח לכם הסבר קצר איך זה יעבוד {{1}}?

לא מעוניינים? לוחצים "לא, תודה" ולא נכתוב שוב.

[שם העסק], [שם מלא], [כתובת]. [אתר]'

jq -n --arg body "$body1" '{name: "alhakav_ask", language: "he", category: "MARKETING",
  components: [{type: "BODY", text: $body, example: {body_text: [["אצל אבי אינסטלציה"]]}},
               {type: "BUTTONS", buttons: [{type: "QUICK_REPLY", text: "כן, שלחו"}, {type: "QUICK_REPLY", text: "לא, תודה"}]}]}' |
curl -sS -X POST "https://graph.facebook.com/v23.0/$META_WABA_ID/message_templates" \
  -H "Authorization: Bearer $META_TOKEN" -H "Content-Type: application/json" --data @-
```

The same for `alhakav_ask_reminder` with its body. Until Meta approves a template, a send answers error 132001 and the
lead's page says so.

## What happens after

- **כן, שלחו** (or "כן" typed): the explanation goes at once as plain text (`server/copy.js`, `MSG.pitch`), with the
  price and `SITE_URL`, since they just wrote to us. The lead moves to "בשיחה".
- **לא, תודה** (or "לא", "הסר", "די" in any short form, at any time): the number goes into `stops`, one line says it
  was removed, the lead closes, and no message goes to it again.
- Anything else they write marks them as answering and opens 24 hours in which you can answer from the lead's page.

## The assistant numbers (the service itself)

Three **Utility** templates on the WhatsApp Business Account the assistant numbers belong to (`TELNYX_WABA_ID`),
submitted through Telnyx or WhatsApp Manager. The bodies are the same text `server/copy.js` (`SVC`) shows on the admin
page; a variable's value never has a line break in it (Meta refuses that).

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
פנייה חדשה משיחה שלא נענתה ב־{{1}}

מה: {{2}}
איפה: {{3}}
דחיפות: {{4}}
טלפון: {{5}}

אפשר לחזור ללקוח בטלפון או בוואטסאפ.
```

### alhakav_call_note, to the customer, when there is no conversation to sum up

| | |
|---|---|
| Category | Utility |
| Variables (sample) | `{{1}}` = `מ־054-123-4567`, `{{2}}` = `10:41`, `{{3}}` = `שלחנו הודעה בוואטסאפ ועוד אין תשובה.` |

```
שיחה שלא נענתה {{1}} ב־{{2}}.
{{3}}

נעדכן כשיהיה משהו חדש.
```

While the customer wrote to their assistant in the last 24 hours, the summary and the note go as plain text instead,
with the same words.
