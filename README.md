# על הקו

A WhatsApp follow-up for missed calls, for plumbers, electricians, AC technicians and locksmiths. This repo has two
things:

- `index.html`, the landing page.
- `server/`, the admin's lead desk, built like openfrequency's `/admin/leads`: it finds tradespeople by itself, scores
  them, and writes to them on WhatsApp from the business number when you press send. Its inbox (`/admin/inbox`) shows
  every WhatsApp message both numbers sent and got, and the owner hears about leads, sales and payments on their own
  WhatsApp.
- `terms.html`, `privacy.html`, `accessibility.html`, the legal pages.
- `docs/connecting.md`, the service itself: each customer's assistant number, how their missed calls reach it (call
  forwarding), the conversation with the caller and the summary, and what to check on the first customer.
- `docs/payments.md`, paying: the bank transfer's picture on WhatsApp, the admin's check, Morning's invoice-receipt,
  the reminders and the 72 hours.

## How the lead desk works

1. **Finding.** Each morning (and whenever you press "למצוא עוד") it searches the Brave Search API for a trade in a city
   ("אינסטלטור באשדוד"), rotating trades and cities by day. Directories, social networks and news sites are dropped. Each
   remaining site is read (its home page, and its contact page when the home page has no mobile). You can also add a
   site by its address.
2. **Scoring.** Out of 100, with the evidence kept for each factor (`server/score.js`): one of the four trades, a mobile
   on the site, a WhatsApp link, one area, Hebrew, a recent year, a person writing about their own work; minus points for
   a call centre or a chain. A directory, a site that is not one of the trades, or a site with no mobile is never a lead.
   55 and up is "מתאימים".
3. **Writing.** The first message carries their own page (`docs/demo.md`) and goes from the business number as an
   approved template (`docs/whatsapp-templates.md`). A scheduled Claude task sends it on working days, to the ones it
   judged fit (`docs/autopilot.md`); on a lead you see the message exactly as they will read it, and one button sends
   it too. One reminder becomes available to the admin four days later, only if they have not answered. Until Meta is set up, the page offers copy-and-open on your own phone, and "שלחתי".
4. **Answers.** Meta's webhook tells the desk how far each message got (sent, delivered, read, not delivered) and what
   they wrote. "כן, שלחו" gets the explanation at once; "לא, תודה" or "הסר" stops everything for that number; any other
   answer opens 24 hours in which you answer from the lead's page. Someone who writes to the business number on their
   own becomes a lead too.

The guardrails are openfrequency-toran's, because the business number's rating is what everything rides on: at most `OUTREACH_DAILY` (10) first messages and reminders a day, never 20:00 to 09:00 or on Shabbat
and holidays, the number's quality read from Meta before each send, and one first message and one reminder per lead,
and the scheduled task at most `AUTOPILOT_BATCH` (5) in a half day and never the reminder. The first message is an offer
with a link, says who writes and how to stop; openfrequency asks permission first instead, following its reading of
the Communications Law's section 30A (docs/autopilot.md). Check this with a lawyer before sending at scale.

## Running it on a server

Node 22.13 or newer, nothing to install (`node:sqlite` is built in). On the VPS it runs like openfrequency-web's lead
server: `deploy/alhakav.service` has the steps (the code in /opt/alhakav, the settings in /etc/alhakav/alhakav.env,
the database in /var/lib/alhakav). The admin password's hash, and a session secret:

```sh
cd /opt/alhakav && ENV_FILE=/nonexistent /opt/node24/bin/node server/main.js password
```

Then add `deploy/Caddyfile.example`'s block, with the real domain, to /etc/caddy/Caddyfile and reload Caddy. The admin
is at `https://<domain>/admin`.

**Finding leads.** A Google Maps key with the Places API (New) on, in `GOOGLE_MAPS_KEY`: each search returns up to 20
businesses with their phone and site (Places' Enterprise request, 1,000 a month free). A key from api-search.brave.com
in `BRAVE_API_KEY` adds sites from the web. `DISCOVER_QUERIES` searches run each morning after 07:00 on both (0 turns
that off). מדרג blocks the server and pro.co.il shows its own forwarding numbers, so neither is a source; someone found
in a Facebook group is added on the leads page, under "להוסיף לפי מספר".

**WhatsApp (Cloud API).** In a Meta app with WhatsApp added, on the business number:
`META_TOKEN` (a system user token), `META_PHONE_ID`, `META_WABA_ID`. For answers, set the app's webhook to
`https://<domain>/meta/webhook` with `META_VERIFY_TOKEN` as the verify token, subscribe to `messages`, and put the
app's secret in `META_APP_SECRET`. Submit the two templates in `docs/whatsapp-templates.md` and set `SENDER_LINE` to
their last line. A number on the Cloud API stops working in the WhatsApp Business app on the phone, unless it is
connected with coexistence.

When the Meta app's webhook already serves something else, leave it and give the business number's WhatsApp Business
Account its own: `POST /<META_WABA_ID>/subscribed_apps` with `override_callback_uri` set to
`https://<domain>/meta/webhook` and `verify_token` set to `META_VERIFY_TOKEN` (alhakav must already be running with that
token, since Meta checks it at once). The fields stay the app's; alhakav reads `messages` and ignores the rest. Then
register the number once, `POST /<META_PHONE_ID>/register` with `messaging_product: "whatsapp"` and a six-digit PIN;
keep the PIN in `META_PIN` (alhakav does not read it, but Meta asks for it to register the number again).

**Payments.** `PAYMENT_DETAILS`, the template `alhakav_payment` (docs/whatsapp-templates.md) submitted on the business
number, and Morning's API keys in `MORNING_CLIENT_ID` and `MORNING_CLIENT_SECRET` (docs/payments.md).

**Pages.** Each lead gets a page of its own with a working try of המוקדן, linked from the first message (docs/demo.md). `DEMO_DAILY` caps the tries a day (30).

**The scheduled task.** `AUTOPILOT_TOKEN`, `AUTOPILOT=1`, the Caddy route on toran.openfrequency.co.il, and the two
routines (docs/autopilot.md).

**The owner's updates.** `OWNER_WA`, the owner's own mobile, and the template `alhakav_update` approved on the business
number (docs/whatsapp-templates.md). Someone new wrote, a lead answered, a page was opened or tried, someone wants to
join, a transfer's picture came, and at 19:00 what the day brought.

**Toran.** openfrequency-toran answers on the business number as על הקו, sends the admin's alerts to their WhatsApp when
`OWNER_WA` cannot, and hands whoever wants to join to the payment message: `OF_INTERNAL_TOKEN` (the same as Toran's),
and על הקו's export synced into Toran (`node server/main.js support <file>`, docs/toran.md).

**Backups.** Everything is in one SQLite file (`/var/lib/alhakav/leads.db` on the VPS). `sqlite3 <file> ".backup <copy>"`
copies it safely while the server runs.

## Commands

```sh
npm start                                   # the server, on 127.0.0.1:4760
npm run discover -- --trade plumber --city אשדוד
npm run discover -- --url avi-plumbing.co.il
npm run leads                               # the newest 20 leads
npm test
```

On a laptop, `ENV_FILE=path/to/.env npm start` and open http://127.0.0.1:4760/admin.
