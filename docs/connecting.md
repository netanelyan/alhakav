# How a customer connects

The plan for the part that isn't built yet: how a plumber's missed call reaches us, how the caller gets a WhatsApp
message, and how the summary reaches the plumber. Researched 2026-11-19; every fact has its source at the end. Where
something could not be confirmed, it says so, and the pilot (step 8 of the build) is where it gets checked.

## The short version

1. **Missed calls reach us by call forwarding.** The plumber dials one code on their own phone, once: when a call
   isn't answered within 20 seconds, the line is busy, or the phone is off, the carrier forwards it to a number we
   rent for that plumber. Works on every Israeli carrier, iPhone and Android, with no app. The caller's number comes
   with the forwarded call.
2. **Our number answers the caller for a few seconds** with the business's name and one question: "to get a WhatsApp
   message and leave details, press 1". Pressing 1 is the caller's permission to be written to on WhatsApp, which
   Meta's rules require.
3. **The WhatsApp message comes from the plumber's own number**, the one the caller just called, through Kapso
   ("coexistence": the WhatsApp Business app keeps working on the plumber's phone, and the plumber sees every message
   there). Claude asks what happened, where, and how urgent.
4. **The summary comes from על הקו's own number** to the plumber's WhatsApp, as on the landing page.

Toran already does steps 3 and 4 for stores (openfrequency-toran `src/channels/kapso.ts`, its own number on Meta), and
openfrequency-accounts already has the bank-transfer payment, so most of the plumbing is a port, not new work.

## What the customer does, once (about 10 minutes, all on WhatsApp with us)

1. **Joins and pays the first month.** Bank transfer, the way openfrequency-accounts does it
   (`docs/internal-pay.md` there): we send the amount and the details, they send a screenshot of the transfer, we check
   the bank and press "התשלום הגיע", and Morning issues the invoice.
2. **Connects their WhatsApp.** We send a Kapso link. They open it, log in to Facebook, and scan a QR code in the
   WhatsApp Business app. Requirements: the **WhatsApp Business app**, version 2.24.17 or later, on a number that has
   been active in it for about 7 days. Someone on personal WhatsApp moves to the Business app first (their chats move
   with them; contacts saved only inside WhatsApp do not).
3. **Turns on forwarding.** We send the codes with their number in them, to type in the phone's dialer (a link
   can't dial codes with * and #, so they are copied, not pressed):
   ```
   **61*07XXXXXXXX**20#     no answer after 20 seconds
   **67*07XXXXXXXX#         busy, or a call they decline
   **62*07XXXXXXXX#         phone off or out of coverage
   *#61#                    check that it's on
   ```
   We tell them before they dial: **this replaces voicemail** (on Israeli networks voicemail is itself a forward on
   these same conditions), and `##61#`, `##67#`, `##62#` undo it.
4. **A test call.** Our number calls them; they don't answer. 20 seconds later the call reaches us, and a test summary
   arrives on their WhatsApp from על הקו. If it doesn't, we know which step to look at.

## What happens on a missed call

```
caller ── calls 054-plumber ──► carrier ── no answer / busy / off ──► 07X number (ours, this plumber's)
                                                                        │ webhook: From = caller, To = which plumber
                                                                        ▼
                                                     our server answers: "שלום, הגעתם ל<עסק>... הקישו 1"
                                                                        │ caller presses 1
                                                                        ▼
               caller's WhatsApp ◄── template from the plumber's own number (Kapso) ──┘
                         │ caller answers
                         ▼
               Claude asks what, where, how urgent (24 hours open once they answer)
                         │
                         ▼
          plumber's WhatsApp ◄── summary from על הקו's number (Meta Cloud API)
```

**The recording** (per customer, in their business's name; plural, so it fits anyone):

> שלום, הגעתם ל<אבי אינסטלציה>. אנחנו באמצע עבודה ולא יכולים לענות כרגע. כדי לקבל מאיתנו הודעה בוואטסאפ ולהשאיר
> פרטים, הקישו 1.

After 1: "תודה, שלחנו לכם הודעה בוואטסאפ." No key within 6 seconds: "אפשר גם להתקשר שוב מאוחר יותר. להתראות." Either
way the call ends there: our number never forwards back to the plumber (that is how a forwarding loop starts).

**The message to the caller**, a Utility template from the plumber's number ("follow-up on a user request", the use
Meta names for it):

> שלום, כאן <אבי אינסטלציה>. ביקשת שנחזור אליך בוואטסאפ אחרי השיחה. מה קרה, ואיפה?

**The summary to the plumber**, a Utility template from על הקו's number (they opted in when they joined):

> פנייה חדשה משיחה שלא נענתה ב־10:41
> מה: … / איפה: … / דחיפות: … / טלפון: 054-…
> אפשר לחזור ללקוח ישר מהצ׳אט שלו אצלכם.

**When it doesn't go the usual way**

| Case | What happens |
|---|---|
| Hidden number (חסוי) | Nothing to write to. The summary says "שיחה ממספר חסוי ב־10:41". |
| Caller doesn't press 1 | No WhatsApp. The summary says who called and when, "לא ביקש הודעה". |
| Caller's number has no WhatsApp (a landline) | The template fails (Meta 131026). The summary says "אין וואטסאפ במספר הזה, כדאי להתקשר". |
| Same caller again within 24 hours | The same conversation continues; no second template. |
| The plumber answers the caller from the phone | Their reply arrives as an echo (Kapso passes Meta's `smb_message_echoes`). Claude stops in that chat, as Toran does for 12 hours. |
| Family, suppliers, regulars | The plumber sends us "לא לשלוח ל־054…" and that number is skipped from then on. (Coexistence also syncs the app's contacts; skipping saved contacts automatically is possible, and worth asking customers about.) |
| A call at night or on Shabbat | The message goes at once: the caller just asked for it. |
| Kapso drops the connection (it warns that coexistence is less stable) | We find out from Kapso's webhook and tell the plumber on WhatsApp the same day, with the link to connect again. |
| A customer without the Business app who won't switch | The message goes from על הקו's number instead, in their business's name. Works, but the caller sees an unknown number. |

## Why this way

- **Forwarding, not an app.** iOS has no way for an app to see missed cellular calls, and Android restricts the call
  log. ITD (Israel) and GoHighLevel do exactly this with forwarding; Sendy (Israel) is an Android app and says it does
  not work on iPhone.
- **A number per customer.** The carrier passes the caller's number, but nothing confirms Israeli carriers pass which
  number forwarded the call, so the number it arrived on (`To`) is what says whose call it is. About $3 to $5.50 a
  month each.
- **Press 1.** Meta's policy: you may write to someone only with their opt-in, naming your business, and a phone (IVR)
  opt-in counts. A missed call alone is not one, and a template sent without it risks being moved to Marketing
  (7 times the price) or reported. Under coexistence the number at risk is the **plumber's own**, so this is the one
  place not to cut a corner. The cost: some callers hang up on any recording. The pilot measures how many.
- **The plumber's own number.** The caller gets an answer from the business they called, which is what the landing
  page shows, and the plumber sees the whole conversation in their own app and can step in.

## What it costs, per customer, per month

At 100 missed calls a month (sources below; prices in dollars as the providers publish them):

| | |
|---|---|
| The 07X number | Telnyx from $3, or Twilio $5.50 |
| Answering the forwarded calls (~15 s each) | under $0.50 (Twilio local inbound $0.0107 a minute) |
| Kapso, the plumber's number | $10 on the Pro plan ($25 a month for the first 3), $5 on the Platform plan ($299 a month for 50) |
| Meta: one template to each caller, one summary each | about $1.06 (Utility $0.0053 each in Israel; the conversation itself is within the 1,000 free service messages a number gets each month) |
| Claude | a few cents a conversation; measured in the pilot |
| **Total** | **about $15 to $20**, against 149 ₪ |

The plumber's own answers from the phone cost nothing.

## Set up once

| | What | Notes |
|---|---|---|
| Telnyx (or Twilio) | An account, and Israeli numbers bought by API | Telnyx asks for a business registration certificate (תעודת עוסק מורשה), proof of address from the last 3 months (any country), and the use. Twilio's Israel requirements and stock could not be confirmed; check before choosing it. |
| Kapso | An account and a project for על הקו, its API key and webhook secret | Toran's code reads them as `KAPSO_API_KEY`, `KAPSO_WEBHOOK_SECRET`. Start on Pro. |
| Meta | על הקו's own number on the Cloud API (like Toran's own number), business verification, and the templates: the caller's message, the summary, the payment reminder, plus the two outreach ones already in `docs/whatsapp-templates.md` | Business verification takes days; start it first. |
| Anthropic | An API key for על הקו | Separate from openfrequency's, so the costs are its own. |
| Morning | An API key, for invoices issued from the admin page | |

## Build order

1. **Customers** in the lead desk: a customer table, its admin page, and a lead turning into one.
2. **Payment:** port openfrequency-accounts' bank-transfer flow (the PAY code, the screenshot, "התשלום הגיע"), and
   issue the Morning invoice on that press.
3. **Numbers:** buy a 07X number per customer through the Telnyx API, and its call webhook: answer, play the
   recording, read the key press, hang up.
4. **The recording:** text to speech in Hebrew with the business's name, or the plumber's own voice note (they send it
   on WhatsApp, we use it as the greeting). A decision below.
5. **Kapso:** port Toran's `src/channels/kapso.ts`: the setup link, the webhook, sending through Kapso.
6. **The conversation:** Claude with the three questions, the stop rules above, and the summary.
7. **Onboarding on WhatsApp:** the four steps above as one guided chat with על הקו's number, with the test call at the
   end.
8. **A pilot with 3 to 5 plumbers** for two weeks: how many callers press 1, how many answer the message, how
   accurate the summaries are, and whether forwarding behaves on each carrier (019 on VoLTE has a reported quirk).

## Decisions for you

1. **Press 1, or send without asking?** I recommend press 1 (above). Without it, more callers get a message and the
   plumber's own number carries the risk.
2. **Telnyx or Twilio?** I recommend Telnyx: cheaper, and its Israel requirements are published. Confirm number stock
   before building step 3.
3. **The greeting: a recorded voice note from the plumber, or text to speech?** The plumber's own voice is warmer and
   needs no TTS provider; TTS needs nothing from them.
4. **Meta's fees inside the 149 ₪?** About 4 ₪ a month at 100 calls. I recommend including them, so the price stays
   one number.
5. **The name.** alhakav.co.il is already a live site of another Israeli business called "על הקו" (recordings for
   phone systems), close to this one's field. Worth checking the trademark register before buying a domain or
   printing anything.
6. **The domain.** The site runs on the VPS now at a temporary address,
   https://alhakav.129-121-89-58.sslip.io. Once there is a domain, its DNS record pointing at 129.121.89.58 and one
   line in /etc/caddy/Caddyfile move it there.

Once 1 to 3 are decided, the landing page and the legal pages change with them: the landing page says the message goes
"מיד כשהשיחה נגמרת" (with press 1 it goes once they press), and two placeholders in the legal pages (the telephony
provider and how a number connects) take their final text.

## Sources

- Forwarding codes and voicemail: Pelephone https://www.pelephone.co.il/digitalsite/heb/support/call-referral/ ;
  Cellcom https://cellcom.co.il/production/Private/Cellular/Cellular_upgrades/follow_me/ ; Partner
  https://www.partner.co.il/n/partnerdigital/gsm_abbreviations ; exm.co.il per-carrier pages
  https://www.exm.co.il/kb/virtual-numbers/call-forward/cellcom.html (and 019.html: voicemail is a conditional forward);
  https://en.wikipedia.org/wiki/Call_forwarding (timer 5 to 30 s); iPhone forwards only everything in Settings:
  https://support.apple.com/guide/iphone/set-up-call-forwarding-iph7405291c4/ios
- Caller ID kept on a forwarded call: Bezeq https://www.bezeq.co.il/internetandphone/phone/service_on_phoneline/stars/
- Twilio Israel numbers and prices (October 2026): https://www.twilio.com/en-us/voice/pricing/il ; caller ID:
  https://www.twilio.com/en-us/guidelines/il/israel--voice-guidelines---twilio ; ForwardedFrom depends on the carrier:
  https://www.twilio.com/docs/voice/twiml
- Telnyx Israel numbers and requirements: https://telnyx.com/phone-numbers/israel ;
  https://support.telnyx.com/en/articles/5466651-israel-did-requirements
- Coexistence: Meta
  https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users ;
  7 days of activity (Wati, 2026-11-17) https://support.wati.io/en/articles/11875544 ; Kapso on its stability (2026-06-07)
  https://kapso.com/blog/whatsapp-business-app-coexistence-cloud-api ; Kapso prices https://kapso.com/pricing
- Templates and opt-in: https://developers.facebook.com/docs/whatsapp/updates-to-pricing/new-template-guidelines ;
  https://developers.facebook.com/docs/whatsapp/overview/getting-opt-in ; https://whatsappbusiness.com/policy/
- Meta prices in Israel from 2026-10-01: https://developers.facebook.com/docs/whatsapp/pricing ;
  https://quickwa.com/blog/whatsapp-business-api-pricing-israel
- Products that do this: ITD https://itd-com.com/נתב-ווטסאפ/ ; Sendy https://www.sendy-auto-app.com/app/ ; GoHighLevel
  https://www.ghlscaleup.com/missed-call-text-back-setup
