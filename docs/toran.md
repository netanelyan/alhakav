# Toran on the business number

openfrequency-toran's agent answers the people who write to the business number, as על הקו: the same agent that
answers OpenFrequency's own support, from what this site says, with its guard and its limits. This server still owns
the number. It keeps every message, does what it already did by itself, and sends Toran's answers from the number.

## Who answers what

A message to the business number goes through these, in order (server/outreach.js, then server/toran.js):

| | The message | What happens |
|---|---|---|
| 1 | The same Meta id again | nothing (a webhook sent twice) |
| 2 | An image or a PDF from a customer who owes a payment | a receipt (docs/payments.md), and the admin is told to check the bank |
| 3 | A stop word ("לא, תודה", "הסר", "די", in any short form) | the number goes into `stops`, one line says so, and nothing is written to it again |
| 4 | An away message or another bot's | kept, counted for nothing |
| 5 | "כן, שלחו" from a tradesperson we wrote to | the explanation, at once, and the admin is told |
| 6 | Anything else, from anyone: a stranger from the site, a lead, a customer | Toran |

Toran gets the person's messages once they stop writing for a moment (`TORAN_DEBOUNCE_MS`, 3 seconds), with a few
lines about who they are here (a stranger, a lead we wrote to and whether they said yes, a customer and where their
payments stand), and with anything the admin wrote to them by hand since Toran last answered. Its answer goes out
from the business number as plain text, kept with the lead as `bot` ("תורן" on the lead's page).

**The admin answers by hand** from the lead's page as before. For 12 hours after that, Toran's answers are not sent
there, and Toran itself stays quiet in that conversation; after that it answers again, knowing what the admin said.

## Joining and paying, in the chat

When someone wants to join, Toran asks for the business name as their callers should see it, and hands them over with
the reason `join`. Then, at once:

1. They become a customer (status "בהקמה"), from their lead, with that name and their own number. A number that is not
   an Israeli mobile cannot be a customer: nothing is sent, and the admin is told.
2. The payment message goes, right after Toran's answer: the first month, 175.82 ₪ with VAT, and `PAYMENT_DETAILS`
   (pay.js, the same message as the customer page's button). Asked again within six hours, it is not sent again.
3. The admin is told on their phone.

From there it is docs/payments.md: they send the transfer's picture, the admin checks the bank and presses "התשלום הגיע",
Morning issues the invoice-receipt, and the admin sets the assistant up (docs/connecting.md).

## The admin's alerts

On the admin's own WhatsApp, through Toran's operator alerts (server/alerts.js): one approved template from
OpenFrequency's number, so the business number never writes to the admin. Each says who, and links to the page.

| Alert | When | At most |
|---|---|---|
| הודעה חדשה מ־... | a stranger's first message, after Toran answered it | once a day for that lead |
| ... ביקשו את ההסבר | "כן, שלחו" | once a day for that lead |
| ... רוצים להצטרף, ופרטי התשלום נשלחו אליהם | a join | every 6 hours for that customer |
| ... רוצים להצטרף, אבל פרטי התשלום לא נשלחו | a join that could not be paid, and why | every 6 hours |
| תורן העביר אליך את ... | any other handoff (a complaint, an account question, a person asked for), with Toran's summary | every 30 minutes for that lead |
| ... שלחו צילום של העברה | a receipt came | once for that receipt |
| תורן לא ענה ל־... | Toran down or slow: someone wrote and nobody answered | every 6 hours for that lead |

Toran's own limits apply on top: at most ten alerts an hour over all its products, one key once an hour on the phone.

## When Toran cannot answer

Not set up (no `OF_INTERNAL_TOKEN`), down, or slower than 90 seconds: a stranger who never heard from us gets the
explanation once (`MSG.welcome`, with the price and the site), and the admin is told someone wrote and needs an answer
from their page. Nothing else goes automatically.

## What Toran knows

`node server/main.js support <file>` writes על הקו's company export (server/support.js): what works today and what not
yet, the way in (`start.kind` "join"), the plan, the site's questions and a few more, and the pages: how it works, the
terms, the privacy policy (without the owner's name, which stays on the page itself) and the accessibility statement.
Toran's agent says only what is in it, and passes on what is not.

After changing a fact here or on a page, write it and sync it into Toran again:

```sh
node server/main.js support /tmp/alhakav-support.json            # on the server, from /opt/alhakav, with the env
cd /opt/toran && sudo -u toran env TORAN_HOME=/opt/toran/private TORAN_ENV=prod NODE_ENV=production \
  /opt/node24/bin/node scripts/company.ts sync /tmp/alhakav-support.json --slug alhakav
```

`--slug alhakav` matters: the default slug, `support`, is OpenFrequency's own support store. Toran does not re-read
this export by itself (only OpenFrequency's), so each change is synced by hand.

The store's domain in Toran is `TORAN_DOMAIN`, else SITE_URL's host. When the site moves to its own domain, sync the
export again under the new one.

## Settings

| Setting | |
|---|---|
| `OF_INTERNAL_TOKEN` | the token Toran checks; the same as in openfrequency-toran's `private/.env`. Unset, Toran is off: the fallback above |
| `TORAN_URL` | Toran on this machine, `http://127.0.0.1:4710` by default |
| `TORAN_DOMAIN` | the company store's domain in Toran, SITE_URL's host by default |
| `TORAN_DEBOUNCE_MS` | how long to wait for more of their messages before asking Toran, 3000 by default |
