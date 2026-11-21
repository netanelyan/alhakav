# Each lead's own page, and trying המוקדן on it

Like openfrequency-toran's pitch pages, each tradesperson we write to gets a small page made for their business, with
a try that works for real. `server/demo.js` has all of it.

## The page

`/p/<code>`, a code of 10 letters and digits made the first time it is needed, so a page is never guessed. Never
indexed (`noindex`), never cached. What it shows, for a plumber, an electrician, an AC technician or a locksmith:

1. "הכנו את הדף הזה בשביל אבי אינסטלציה", and what על הקו does, in two lines.
2. **לנסות על עצמכם, בדקה**: a button to WhatsApp המוקדן with the page's code in the message.
3. A missed call to their business, and the summary they would get, from their own trade, at an address in their own
   city when the lead has one. The names, addresses and numbers are made up, and the page says so.
4. The price, and a button to write to the business number, where Toran's sales bot answers.

Each view is counted on the lead (`page_views`, `page_first_at`, `page_last_at`), and the admin is told on their phone
the first time in a day ("אבי אינסטלציה פתחו את הדף שלהם"). The lead's admin page has a "הדף שלהם" card: the address,
the views, and the tries.

## How it reaches them

The first message (`alhakav_ask`) asks whether we may send a short explanation. "כן, שלחו" brings the page at once
(copy.js `MSG.pitch`): one honest line on what the page is, the address, that they can try it on themselves, and the
price. Nothing else sends it; the admin can also copy it from the lead's page and send it by hand.

## The try

The message the button opens, "אני רוצה לנסות (<code>)", goes to המוקדן's number. Then:

1. המוקדן says they are now the customer, as if they called their own business and nobody answered, and sends the very
   message a caller of theirs gets (`alhakav_caller`'s words).
2. They answer as a customer would; Claude asks what it asks every caller (claude.js), in their business's name.
3. At the end: the summary their business would get, then one line asking whether they want it on their number, with
   the business number's WhatsApp.

The admin is told when a try starts ("אבי אינסטלציה מנסים את המוקדן על עצמם"). A try ends after 12 of their messages or 2
quiet hours; a page gets at most 5 tries a day, and all pages together `DEMO_DAILY` (30), so Claude's bill stays small.
Past that, one line says to try again tomorrow. The tries are kept 30 days.
