# The scheduled task that writes to tradespeople

The owner, 2026-11-21: "i want a claude scheduled task to send the messages for tradespeople", and on the first
message: "it should be sent in the first message. they dont have time to text, they see a url with a promise and they
click."

Two halves, the way openfrequency-toran's lead autopilot works (its docs/autopilot.md):

- **The scheduled task** (Claude Code routines on the owner's subscription, in Anthropic's cloud) is the one who
  writes: it finds plumbers, electricians, AC technicians and locksmiths on the web, adds their sites, looks at each
  one, sends the first message to the ones that fit and sets the rest aside, then leaves the owner a note. It runs on
  working days at 09:40 and 14:40 Israel time. This file is its playbook.
- **The server** (always on) does everything after that: the first message carries their own page (docs/demo.md),
  the owner hears when they open it or try המוקדן, Toran's sales bot answers whatever they write, and joining pays in
  the chat (docs/toran.md, docs/payments.md). Nothing waits for a scheduled run once they answered.

## The first message

It is an offer with a link from the start: the template `alhakav_page` (docs/whatsapp-templates.md), a few lines on
what על הקו does, the button "לראות את הדף שלכם" that opens their page, "לא, תודה" to stop us for good, and the line
that says who writes. Section 30A of the Communications Law, as the Supreme Court read it (רע"א 1954/14 חזני נ'
הנגבי), allows a business one approach to another business only to ask whether it may send offers; openfrequency asks
first for that reason. The owner chose the link in the first message knowing this. So the task sends one message a
business and never the reminder (only the admin can, by hand), and a "לא" or "הסר" in any form stops everything.

## The door

`https://toran.openfrequency.co.il/alhakav/autopilot/...`, JSON in and out (server/autopilot.js). The routines run in
the claude.ai environment "Lead autopilot", which reaches no host but toran.openfrequency.co.il, so Caddy hands that
host's `/alhakav/autopilot/*` to על הקו's server (deploy/Caddyfile.example). The key (`AUTOPILOT_TOKEN` in
/etc/alhakav/alhakav.env) is in each routine's own instructions: the run exports it once as `ALHAKAV_KEY` and sends
`Authorization: Bearer $ALHAKAV_KEY` on every request. Never print, echo or write the key anywhere else. A 401 means
the key is wrong, a 503 that the server has none: stop, and say so in the run's answer.

| | |
|---|---|
| `GET /state` | `on`, `quiet` and `quietUntil` (night, Shabbat, a holiday), `half` (morning/afternoon), `limits {day, batch}`, `sent {day, half}`, `room`, `template {name, status}`, `quality` (the number's rating), `pool {ready, belowBar}`, `last24h {sent, delivered, read, notDelivered, openedPage, tried, answered, stopped}`, `lastSearch` |
| `GET /candidates?limit=30` | the leads it may write to, best score first: `id, name, nameInMessage, trade, city, domain, url, score, why (the score's parts), about, whatsappOnSite, notes`. No phone numbers |
| `GET /site?id=` | the lead's home page as text, read by the server: `home {url, status, title, text}`. The task reaches nothing on the internet but this door: read sites here, never with WebFetch |
| `POST /add {urls}` | up to 15 sites by address. The server reads each and keeps it as a lead only when it is one of the four trades with a mobile on it: `{stats, known, results [{site, id, name, score, fit, reject}]}` |
| `POST /send {id, name?, reason}` | the first message, with their page. `name`: what the message calls them, only when the site's own name is wrong for it. `reason`: one short line in Hebrew, kept in the lead's notes. `{sent, why, page, nameInMessage}` |
| `POST /skip {id, reason}` | sets the lead aside, with the reason in its notes |
| `GET /recent?hours=24` | each lead written to, answering or opening their page in that time: `name, trade, city, sentAt, state, pageViews, tried, answered, closed` |
| `POST /note {text, tell}` / `GET /notes` | a note for the owner, in Hebrew; `tell: true` also sends it to the owner's WhatsApp |

`send` refuses with a reason, never throws: `quiet`, `cap`, `batch_cap`, `off`, `setup` mean stop this run;
`template_pending` means Meta has not approved the first message yet, so send nothing this run (adding sites is still
useful); `quality` means Meta lowered the number's rating, so stop and say so in the note; `already`, `not_candidate`,
`stopped`, `closed`, `noMobile` mean skip that lead; `failed` and `undelivered` are Meta refusing, so move on and,
after three, stop and note it.

## A morning or afternoon run

1. `GET /state`. Off: note "הטייס כבוי" once a day (skip it when `GET /notes` shows one today) and stop. Quiet: stop.
2. **Find more when the pool is low.** When `pool.ready` is under 15, search the web with WebSearch, in Hebrew: a
   trade in a city, "אינסטלטור באשדוד", "חשמלאי בחולון", "טכנאי מזגנים בבאר שבע", "מנעולן ברמת גן". Take the four trades
   in turn and a different city each run (Israel's cities and towns, big and small; begin with the ones in
   server/sources.js SEARCH_CITIES), up to 6 searches a run. From the results keep only a tradesperson's own site,
   on its own domain (a Wix or a WordPress site of the business is fine). Leave out directories and lead sites
   (b144, דפי זהב, מדרג, easy, zap, homeless, "100 בעלי מקצוע בעיר"), social networks, news and ads. `POST /add` them,
   15 at a time, at most 30 a run. The server reads each one and drops what is not a lead.
3. When `template.status` is not `APPROVED`: send nothing. Note "ההודעה הראשונה עוד מחכה לאישור של Meta" with what was
   added, and stop.
4. Room this run: `room`. None: go to step 7.
5. `GET /candidates?limit=30`. For each, best first, until the room is used:
   - **Look at the site.** `GET /site?id=<id>` with its candidate facts. Read it the way a careful salesperson would:
     is it one tradesperson or a small business (one owner, a few workers, one area), in one of the four trades,
     working now, in Israel, in Hebrew, and is the mobile on it theirs? A site that did not load (`home.status` 0, or
     400 and up) is not written to this run.
   - **Set it aside (`POST /skip`)** with the reason when it is any of these: a big company, a chain or a franchise,
     a call centre that sends technicians; a directory or a site that sells leads; another trade (a renovation
     contractor, a plumbing supply shop, an AC showroom, a security systems company); a site years old with nothing
     current; a business that already says it answers 24/7 with a call centre.
   - **The name.** The message says "איך זה ייראה אצל <name>". Send `name` when the site's name is wrong for that: a
     company suffix (בע״מ), an English slug, a keyword title ("אינסטלטור בתל אביב 24/7 | מחירים"), or the owner's full
     name when the business has a name. Use what people call them: "אבי אינסטלציה", "החשמלאי של רמת גן". Leave it out
     when the name is fine.
   - `POST /send {id, name?, reason}`, the reason one short Hebrew line on why they fit. Read its `why` as above.
   - Never write to a lead you set aside, and never more than the room.
6. Do not message anyone in any other way. The door sends the one message; everything after it is the server's.
7. `POST /note` with a short note in Hebrew for the owner, in plain words, no English and no codes: how many got the
   message, how many were set aside and the usual reasons, how many sites were added, and anything that needs them
   (Meta's rating, the template, sends that failed, the pool running dry).
   **The afternoon run** also sends the day to the owner's WhatsApp: `GET /recent?hours=12` and post one note with
   `{"text": "...", "tell": true}`, under 600 characters: how many got the message today, who opened their page,
   who tried המוקדן, who answered (by name), who asked to stop. No phone numbers.

## Rules

- Never print, store or repeat the key. Never put a phone number in a note; a business's name is enough.
- Never send anything but through the door, and never contact a business, a person or a service on your own.
- Do not change code, open pull requests or push. The checkout is for reading this file.
- The owner reads the notes on their phone: Hebrew, short, plain, no em dashes, no exclamation marks.

## Setting it up again

On the server: `AUTOPILOT_TOKEN` (`openssl rand -hex 24`), `AUTOPILOT=1` (anything else turns its writes off at
once), and `AUTOPILOT_BATCH` (5 a half day; the day's cap is `OUTREACH_DAILY`, 10). The routines "על הקו: morning
batch" (`40 7 * * 0-5`, UTC) and "על הקו: afternoon batch" (`40 12 * * 0-4`) in the environment "Lead autopilot",
with this repo as their source and the tools Bash, Read, Glob, Grep and WebSearch. A new key goes in the server's env
and in both routines.
