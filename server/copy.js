// Every word the admin pages and the messages say, in one place, written by the hebrew-voice guide: plain verbs, the
// thing first, no slogans, no em dashes, no exclamation marks. Buttons are verbs in the infinitive, the way
// openfrequency's admin says them ("לשלוח", "לדלג"), and what the admin did is in their own first person ("שלחתי").

export const TRADE = { plumber: 'אינסטלטור', electrician: 'חשמלאי', ac: 'טכנאי מזגנים', locksmith: 'מנעולן' };

/** Why a lead was closed, as the admin picks it, and the ways it closes by itself. */
export const LOST = { not_interested: 'לא מעוניינים', has_solution: 'יש להם כבר פתרון', price: 'יקר להם', no_answer: 'לא עונים', other: 'אחר' };
export const CLOSED = { ...LOST, customer: 'הפכו ללקוחות', stopped: 'ביקשו להסיר', skipped: 'דילגנו' };

// ---- The messages to a tradesperson.
//
// Israel's anti-spam rule (the Communications Law, section 30A) lets a business make one approach to another business
// asking whether it may send an offer, when it says who writes and how to stop: so the first message asks, the line
// at its end says who we are, and "לא, תודה" (or "לא", "הסר", "די" in any short form) stops us for good. The one
// reminder is the last message. openfrequency's openfrequency_ask template, for על הקו.
//
// The first and the reminder go from the business number as Meta-approved templates (docs/whatsapp-templates.md); the
// text here is the same body, filled in, so the admin sees what the tradesperson will read. {{1}} is "אצל <name>".

export const MSG = {
  first: (n, sender, byHand) =>
    [
      'שלום, כאן על הקו. כשאתם באמצע עבודה ולא עונים לטלפון, אנחנו שולחים למי שהתקשר הודעה בוואטסאפ, מבררים מה הוא צריך, ושולחים לכם סיכום.',
      `אפשר לשלוח לכם הסבר קצר איך זה יעבוד ${n}?`,
      byHand ? 'לא מעוניינים? עונים "לא" ולא נכתוב שוב.' : 'לא מעוניינים? לוחצים "לא, תודה" ולא נכתוב שוב.',
      sender,
    ].join('\n\n'),
  reminder: (n, sender, byHand) =>
    [
      `שלום שוב, כאן על הקו. לפני כמה ימים שאלנו אם אפשר לשלוח לכם הסבר קצר איך זה יעבוד ${n}: מי שמתקשר ולא מקבל מענה מקבל מאיתנו הודעה בוואטסאפ, ואתם מקבלים סיכום.`,
      byHand ? 'זו ההודעה האחרונה שלנו בנושא. עונים "כן" ונשלח, או "לא" ולא נכתוב שוב.' : 'זו ההודעה האחרונה שלנו בנושא. לוחצים "כן, שלחו" ונשלח, או "לא, תודה" ולא נכתוב שוב.',
      sender,
    ].join('\n\n'),
  // After "כן, שלחו": they wrote to us, so this goes as plain text, at once, with the page we made them (demo.js).
  pitch: (biz, url) =>
    [
      `תודה שעניתם. הכנו דף קטן רק בשביל ${biz}: מה מקבל מי שהתקשר ולא עניתם, ומה מגיע אליכם אחר כך.`,
      url,
      'בדף יש כפתור לנסות את זה על עצמכם בוואטסאפ. לוקח דקה.',
      '149 ₪ לחודש, לא כולל מע״מ, ואין דמי הקמה. אם משהו לא ברור, אפשר לשאול כאן.',
    ]
      .filter(Boolean)
      .join('\n\n'),
  // To someone who wrote to us first, when Toran could not answer them (docs/toran.md): once, and a person follows.
  welcome: (site) =>
    [
      'היי, תודה על ההודעה. ככה על הקו עובד:',
      'כשאתם לא עונים לשיחה, מי שהתקשר מקבל מאיתנו הודעה בוואטסאפ מיד כשהשיחה נגמרת. אנחנו שואלים אותו מה קרה, איפה, ואם זה דחוף, ושולחים לכם סיכום אחד עם המספר שלו.',
      '149 ₪ לחודש, לא כולל מע״מ. אין דמי הקמה, ומשלמים חודש בחודש.',
      site ? `ככה זה נראה: ${site}` : '',
      'ההודעה שלכם אצלנו, ונחזור אליכם כאן.',
    ]
      .filter(Boolean)
      .join('\n\n'),
  stopped: 'הסרנו את המספר שלכם, ולא נכתוב אליכם שוב.',
  senderMissing: '[שורת הזיהוי: שם העסק, שם מלא, כתובת ואתר]',
};

// ---- The admin pages

export const T = {
  brand: 'על הקו',
  nav: { leads: 'לידים', reached: 'פנינו אליהם', customers: 'לקוחות', logout: 'לצאת' },
  login: {
    title: 'כניסה',
    password: 'סיסמה',
    go: 'להיכנס',
    wrong: 'הסיסמה לא נכונה.',
    tooMany: 'היו יותר מדי ניסיונות. אפשר לנסות שוב בעוד רבע שעה.',
    notSet: 'עוד לא הוגדרה סיסמה. מריצים על השרת npm run admin:password ושמים את השורה שיוצאת ב־private/.env.',
  },
  setup: {
    meta: 'השליחה מהמספר של העסק עוד לא מחוברת (META_TOKEN ו־META_PHONE_ID). עד אז שולחים מהטלפון: מעתיקים, פותחים את הצ׳אט, ואז לוחצים "שלחתי".',
    webhook: 'התשובות מוואטסאפ עוד לא מגיעות לכאן (META_APP_SECRET ו־META_VERIFY_TOKEN), אז מי שעונה או לוחץ "לא, תודה" לא יסומן לבד.',
    brave: 'החיפוש האוטומטי לא מחובר (BRAVE_API_KEY), אז לידים חדשים נכנסים רק מכתובת שמוסיפים כאן.',
    sender: 'שורת הזיהוי בסוף ההודעה עוד לא מוגדרת (SENDER_LINE). החוק מחייב שם וכתובת של מי ששולח, והיא צריכה להיות זהה לשורה בתבנית שאושרה.',
  },
  leads: {
    title: 'לידים',
    lead: 'בעלי מקצוע שמצאנו ועוד לא כתבנו להם, לפי הציון, הגבוה למעלה.',
    tabs: { fit: 'מתאימים', below: 'מתחת לסף', all: 'הכול' },
    search: 'חיפוש לפי שם, אתר, עיר או טלפון',
    searchGo: 'לחפש',
    empty: 'אין כאן לידים',
    emptyLead: 'ליד מופיע כאן כשהחיפוש מוצא בעל מקצוע שמתאים, או כשמוסיפים אתר בכתובת שלו.',
    noneFound: (q) => `אין כאן ליד שמתאים ל״${q}״.`,
    addLabel: 'הכתובת של אתר',
    addPlaceholder: 'למשל avi-plumbing.co.il',
    add: 'להוסיף',
    find: 'למצוא עוד',
    findTrade: 'מקצוע',
    anyTrade: 'כל המקצועות',
    findCity: 'עיר (לא חובה)',
    findGo: 'לחפש',
    running: 'החיפוש רץ עכשיו. מה שיימצא יופיע כאן בעוד כמה דקות, והדף מתעדכן לבד.',
    last: (when, looked, fit) =>
      `בחיפוש האחרון, ${when}, נבדקו ${looked === 1 ? 'אתר אחד' : `${looked} אתרים`}${fit ? ` ונוספו ${fit === 1 ? 'בעל מקצוע אחד שמתאים' : `${fit} בעלי מקצוע שמתאימים`}` : ', ואף אחד מהם לא התאים'}.`,
    lastFailed: (why) => `החיפוש האחרון נעצר באמצע: ${why}`,
    daily: (n) => `כל בוקר החיפוש רץ לבד, ${n === 1 ? 'שאילתה אחת' : `${n} שאילתות`}.`,
    send: 'לשלוח הודעה',
    open: 'לפתוח',
    skip: 'לדלג',
    started: 'החיפוש התחיל.',
    busy: 'כבר רץ חיפוש. אפשר להתחיל חדש כשהוא נגמר.',
    added: (name, score) => `נוסף: ${name}, ציון ${score}.`,
    addedBelow: (name, why) => `נוסף, אבל לא עבר את הסף: ${name}. ${why || ''}`.trim(),
    addFailed: (why) => `לא הצלחתי לקרוא את האתר: ${why}`,
    addBad: 'זו לא כתובת של אתר.',
  },
  reached: {
    title: 'פנינו אליהם',
    lead: 'בעלי המקצוע שכבר שלחנו להם הודעה, ומי שכתב אלינו. כאן רואים מי ענה, ולמי הגיע הזמן לתזכורת.',
    tabs: { waiting: 'מחכים לתשובה', talking: 'בשיחה', closed: 'סגורים', all: 'הכול' },
    empty: 'עוד לא פנינו לאף אחד',
    emptyLead: 'ליד עובר לכאן כשההודעה הראשונה אליו יוצאת, או כשמישהו כותב למספר של העסק.',
    back: 'לידים',
  },
  stage: { new: 'חדש', waiting: 'מחכים לתשובה', talking: 'בשיחה', closed: 'סגור' },
  out: {
    not_sent: 'לא נשלח',
    failed: 'השליחה נכשלה',
    undelivered: 'לא הגיעה',
    sent: 'נשלחה',
    delivered: 'הגיעה',
    read: 'נקראה',
    yes: 'אמרו כן',
    replied: 'ענו',
    stopped: 'ביקשו להסיר',
    inbound: 'כתבו אלינו',
  },
  funnel: {
    sent: ['נשלחה', 'נשלחו'],
    delivered: ['הגיעה', 'הגיעו'],
    read: ['נקראה', 'נקראו'],
    yes: ['אמר כן', 'אמרו כן'],
    replied: ['ענה', 'ענו'],
    undelivered: ['לא הגיעה', 'לא הגיעו'],
    stopped: ['ביקש להסיר', 'ביקשו להסיר'],
    customer: ['הפך ללקוח', 'הפכו ללקוחות'],
  },
  // A lead's own page (demo.js), on the admin's lead page.
  page: {
    title: 'הדף שלהם',
    hint: 'נשלח להם לבד אחרי "כן, שלחו". אפשר גם להעתיק ולשלוח בעצמכם.',
    views: (n, ago) => `נפתח ${n === 1 ? 'פעם אחת' : `${n} פעמים`}, לאחרונה ${ago}.`,
    noViews: 'עוד לא נפתח.',
    demos: (n) => `ניסו את המוקדן על עצמם ${n === 1 ? 'פעם אחת' : `${n} פעמים`}.`,
    noDemos: 'עוד לא ניסו את המוקדן.',
  },
  lead: {
    noTrade: 'מקצוע לא ידוע',
    noMobile: 'אין נייד',
    waOnSite: 'וואטסאפ באתר',
    score: (n) => `ציון ${n}`,
    due: 'הגיע הזמן לתזכורת',
    laterDue: 'הגיע הזמן לחזור אליהם',
    later: (when) => `חוזרים אליהם ${when}`,
    inbound: 'כתבו אלינו',
    notFound: 'אין ליד כזה',
    back: 'לרשימה',
  },
  send: {
    title: 'מה שולחים',
    asRead: 'ככה הם יקראו את ההודעה',
    first: 'לשלוח מהמספר של העסק',
    reminder: 'לשלוח את התזכורת',
    copyOpen: 'להעתיק ולפתוח וואטסאפ',
    markSent: 'שלחתי',
    markReminded: 'שלחתי את התזכורת',
    went: (day, how) => `ההודעה יצאה ב־${day}${how === 'hand' ? ', מהטלפון' : ''}.`,
    reminderWent: (day) => `התזכורת יצאה ב־${day}.`,
    notDue: (when) => `התזכורת האחת תהיה מוכנה ${when}.`,
    done: 'נשלחו ההודעה והתזכורת. מכאן לא כותבים להם יותר, אלא אם יכתבו.',
    answered: 'הם ענו, אז לא שולחים תזכורת. ממשיכים בשיחה למטה.',
    nameTitle: 'השם בהודעה',
    nameHint: 'כך הוא מופיע אחרי "איך זה יעבוד". אפשר לתקן אם השם מהאתר ארוך או מוזר.',
    nameSave: 'לשמור',
    sentFirst: 'ההודעה נשלחה מהמספר של העסק.',
    sentReminder: 'התזכורת נשלחה.',
    marked: 'סימנתי שההודעה נשלחה.',
    failed: (why) => `ההודעה לא נשלחה. ${why}`,
  },
  guard: {
    noMobile: 'אין נייד באתר שלהם, אז אין לאן לשלוח בוואטסאפ.',
    stopped: 'ביקשו להסיר, אז לא כותבים להם יותר.',
    already: 'ההודעה הראשונה כבר נשלחה.',
    noFirst: 'קודם שולחים את ההודעה הראשונה.',
    done: 'התזכורת כבר נשלחה.',
    answered: 'הם כבר ענו, אז לא שולחים תזכורת.',
    unreached: 'ההודעה הראשונה לא הגיעה אליהם, אז גם תזכורת לא תגיע. אפשר להתקשר אליהם, או לסגור את הליד.',
    closed: 'הליד סגור. מחזירים אותו לרשימה כדי לכתוב לו.',
    quiet: (when) => `עכשיו לא כותבים לבעלי מקצוע (ערב, לילה, שבת או חג). אפשר לשלוח ${when}.`,
    cap: (n) => `היום יצאו כבר ${n} הודעות ראשונות ותזכורות מהמספר של העסק, וזה המקסימום ליום (OUTREACH_DAILY). מחר אפשר להמשיך.`,
    quality: (q) => `הדירוג של המספר אצל Meta הוא ${q}, אז השליחה עצורה עד שהוא חוזר לירוק.`,
  },
  graph: {
    132001: 'התבנית עוד לא אושרה ב־Meta, או שהשם שלה שונה מ־TEMPLATE_FIRST או TEMPLATE_REMINDER.',
    131026: 'וואטסאפ לא הצליח למסור אותה. כנראה שאין וואטסאפ במספר הזה.',
    131047: 'עברו 24 שעות מההודעה האחרונה שלהם, אז אפשר לשלוח רק תבנית.',
    131049: 'Meta לא מסר אותה, כדי לא להציף את המספר הזה בהודעות שיווקיות. אפשר לנסות שוב בעוד כמה ימים.',
    131050: 'בעל המספר חסם הודעות שיווקיות מעסקים.',
    131030: 'המספר לא ברשימת המספרים שחשבון הבדיקה ב־Meta מורשה לכתוב אליהם.',
    130429: 'יצאו יותר מדי הודעות בזמן קצר. אפשר לנסות שוב בעוד כמה דקות.',
    131056: 'יצאו יותר מדי הודעות למספר הזה בזמן קצר. אפשר לנסות שוב בעוד כמה דקות.',
    190: 'הטוקן של Meta פג או בוטל (META_TOKEN).',
    other: (msg) => `Meta החזיר שגיאה: ${msg}`,
  },
  chat: {
    title: 'השיחה',
    none: 'עוד לא נשלחה הודעה ולא הגיעה אף אחת.',
    open: (until) => `אפשר לענות להם מכאן עד ${until}, 24 שעות מההודעה האחרונה שלהם.`,
    closed: 'עברו 24 שעות מההודעה האחרונה שלהם. וואטסאפ נותן לכתוב שוב רק אחרי שהם כותבים.',
    replyLabel: 'התשובה שלך',
    send: 'לשלוח',
    sent: 'התשובה נשלחה.',
    empty: 'אין מה לשלוח.',
    auto: 'הודעה אוטומטית מהטלפון שלהם',
    status: { sent: 'נשלחה', delivered: 'הגיעה', read: 'נקראה', failed: 'לא הגיעה', hand: 'נשלחה מהטלפון' },
    kind: { first: 'ההודעה הראשונה', reminder: 'התזכורת', pitch: 'ההסבר, אחרי שאמרו כן', stopped: 'אחרי שביקשו להסיר', reply: '', pay: 'בקשת תשלום', receipt: 'אחרי אישור העברה', paid: 'אחרי שהתשלום נרשם', bot: 'תורן', welcome: 'ההסבר האוטומטי' },
  },
  stands: {
    title: 'איפה זה עומד',
    replied: 'ענו לי בטלפון',
    customer: 'הפכו ללקוחות',
    tomorrow: 'לחזור אליהם מחר',
    week: 'בעוד שבוע',
    lost: 'לא מעוניינים',
    lostWhy: 'למה',
    lostSave: 'לסגור',
    skip: 'לדלג עליהם',
    reopen: 'להחזיר לרשימה',
    stop: 'ביקשו שלא נכתוב להם',
    stopHint: 'המספר עובר לרשימת המספרים שלא כותבים אליהם, כמו אחרי "לא, תודה" בוואטסאפ, והליד נסגר. מכאן אי אפשר לבטל את זה.',
    stopSure: 'כן, לא לכתוב להם',
    notes: 'הערות',
    notesSave: 'לשמור',
    closedAs: (why) => `סגור: ${why}.`,
    done: { stop: 'המספר ברשימת המספרים שלא כותבים אליהם.', replied: 'סימנתי שענו.', customer: 'סימנתי שהפכו ללקוחות.', later: (when) => `נחזור אליהם ${when}.`, lost: 'הליד נסגר.', skip: 'דילגתי עליהם.', reopen: 'הליד חזר לרשימה.', notes: 'ההערות נשמרו.', name: 'השם נשמר.' },
  },
  details: {
    title: 'פרטים',
    mobile: 'נייד',
    others: 'טלפונים נוספים',
    specials: 'מספרי מוקד',
    site: 'האתר',
    found: 'איך מצאנו',
    added: 'נוסף',
    sources: { brave: (q) => `בחיפוש "${q}"`, admin: () => 'הוספתי בכתובת', seed: () => 'מקובץ seeds', whatsapp: () => 'כתבו למספר של העסק' },
    scoreTitle: (n) => `למה הציון ${n}`,
    factor: { trade: 'מקצוע', mobile: 'נייד', whatsapp: 'וואטסאפ', local: 'אזור', hebrew: 'עברית', alive: 'עדכני', owner: 'אדם אחד', chain: 'מוקד או רשת', special: 'מספר מוקד' },
    reject: (why) => `לא עבר את הסף: ${why}`,
  },
  end: {
    title: 'מחיקה',
    remove: 'למחוק את הליד',
    sure: 'כן, למחוק',
    hint: 'הליד וההודעות שלו נמחקים. האתר נשאר ברשימת האתרים שנבדקו, אז החיפוש לא יוסיף אותו שוב, ומספר שביקש להסיר נשאר חסום.',
    done: 'הליד נמחק.',
  },
  csrf: 'הטופס פג. רעננתי את הדף, אפשר לנסות שוב.',
  notFound: 'הדף הזה לא קיים.',
  error: 'משהו נשבר בשרת. הפרטים בלוג.',
};

// ---- The service: what המוקדן, the assistant number every customer shares, says to a caller and to its customer
// (docs/connecting.md).
//
// The first message to a caller and the summary and the note to the customer go as templates when no 24-hour window is
// open (docs/whatsapp-templates.md has them for Meta); the text here is the same body, filled in. A caller is addressed
// in a form that fits anyone; the business in plural, by its name.

export const SVC = {
  callerFirst: (business) => `שלום, כאן העוזר של ${business}. ראינו שהתקשרת ולא הצליחו לענות. מה קרה, ואיפה? הפרטים יעברו אליהם, והם יחזרו אליך כשיתפנו.\n\nלא רלוונטי? אפשר לכתוב "הסר".`,
  callerStopped: 'הסרנו את המספר, ולא נכתוב שוב.',
  // To someone who wrote to המוקדן and neither called one of our customers lately nor is one.
  stranger: (site) => `שלום, כאן המוקדן של על הקו. אני כותב למי שהתקשר לבעל מקצוע שעובד איתנו ולא קיבל מענה, ומעביר לבעל המקצוע את הפרטים. אם התקשרת למישהו לאחרונה, הוא יחזור אליך.${site ? `\n\nמה זה על הקו: ${site}` : ''}`,
  callerThanks: (business) => `תודה, הפרטים אצל ${business} והם יחזרו אליך כשיתפנו.`,
  summary: ({ time, what, place, urgency, phone }) => `התקשרו אליכם ב־${time} ולא עניתם. זה מה שצריך:\n\nמה: ${what}\nאיפה: ${place}\nכמה דחוף: ${urgency}\nטלפון: ${phone}\n\nאפשר לחזור בטלפון או בוואטסאפ.`,
  note: ({ from, time, line }) => `התקשרו אליכם ${from} ב־${time} ולא עניתם.\n${line}\n\nנעדכן כשיהיה משהו חדש.`,
  from: (phone) => `מ־${phone}`,
  fromHidden: 'ממספר חסוי',
  unknown: 'לא נאמר',
  lines: {
    noReply: 'שלחנו הודעה בוואטסאפ ועוד אין תשובה.',
    noWhatsapp: 'ההודעה בוואטסאפ לא הגיעה, כנראה שאין וואטסאפ במספר הזה. כדאי להתקשר.',
    hidden: 'המספר חסוי, אז אי אפשר לכתוב אליו.',
    stopped: 'ביקשו שלא נכתוב אליהם יותר בוואטסאפ.',
    failed: 'לא הצלחנו לשלוח הודעה בוואטסאפ. כדאי להתקשר.',
    test: 'זו שיחת בדיקה, והעוזר קיבל אותה. הכול מחובר.',
  },
  owner: {
    help: () => `כאן המוקדן של על הקו. כשאתם לא עונים, אני כותב למי שהתקשר, ושולח לכם לכאן מה הוא צריך.\n\nמישהו לא צריך לקבל ממני הודעה, כמו אמא או ספק? כתבו "לא לשלוח" ואת המספר שלו.\n\nרוצים שאפסיק לכתוב לכולם לזמן מה? כתבו "לעצור". כדי שאחזור, "להמשיך".\n\nעל תשלום כותבים למספר של על הקו, זה ששלח לכם את פרטי התשלום.`,
    skipped: (phone) => `סגור, ${phone} לא יקבל ממני הודעות.`,
    unskipped: (phone) => `סגור, ${phone} יקבל שוב הודעות כשלא תענו לו.`,
    paused: 'עצרתי. לא אכתוב למתקשרים עד שתכתבו "להמשיך".',
    resumed: 'ממשיכים. מעכשיו אכתוב שוב למי שלא עניתם לו.',
  },
};

export const CUST_STATUS = { setup: 'בהקמה', active: 'פעיל', paused: 'עצור', stopped: 'הפסיק' };
export const CHAT_STATE = { waiting: 'מחכה לתשובה', talking: 'בשיחה', done: 'נשלח סיכום', stopped: 'ביקשו להסיר', failed: 'לא הגיעה' };
export const CALL_OUTCOME = { messaged: 'נשלחה הודעה', again: 'התקשר שוב', hidden: 'מספר חסוי', skipped: 'ברשימת "לא לשלוח"', test: 'שיחת בדיקה', failed: 'השליחה נכשלה', inactive: 'העוזר לא פעיל', unpaid: 'לא שולם', otp: 'קוד אימות (מההקמה הקודמת)' };

export const TC = {
  nav: 'לקוחות',
  title: 'לקוחות',
  lead: 'בעלי המקצוע שמשתמשים בשירות: העוזר של כל אחד, השיחות שהגיעו אליו, ומה נשלח.',
  empty: 'עוד אין לקוחות',
  emptyLead: 'לקוח נוסף כאן מליד שסימנתם "הפכו ללקוחות", או בטופס למטה.',
  add: 'לקוח חדש',
  fields: { name: 'שם', business: 'שם העסק, כמו שמי שמתקשר מכיר אותו', trade: 'מקצוע', phone: 'הוואטסאפ שלהם, לסיכומים', assistant: 'המספר שלהם ב־Telnyx, שאליו עוברות השיחות' },
  save: 'לשמור',
  create: 'להוסיף',
  created: 'הלקוח נוסף.',
  saved: 'נשמר.',
  bad: 'חסר שם, שם עסק או מספר נייד תקין.',
  back: 'לקוחות',
  setup: {
    telnyx: 'Telnyx עוד לא מחובר (TELNYX_API_KEY ו־TELNYX_PUBLIC_KEY), אז שיחות שהועברו לא מגיעות לכאן.',
    assist: 'המספר של המוקדן עוד לא מחובר (ASSIST_PHONE_ID), אז העוזר לא יכול לכתוב למתקשרים ולשלוח סיכומים.',
    claude: 'Claude עוד לא מחובר (ANTHROPIC_API_KEY). עד אז העוזר מודה למי שעונה ומעביר לכם את מה שכתב, בלי לשאול שאלות.',
  },
  steps: {
    title: 'ההקמה',
    assistant: 'המספר שאליו עוברות השיחות',
    assistantHint: 'קונים מספר ישראלי לשיחות בלבד ב־Telnyx, מחברים אותו לאפליקציית הקול, ומדביקים אותו כאן. בוואטסאפ כותב המוקדן, מהמספר המשותף.',
    forward: 'העברת השיחות',
    forwardHint: 'שולחים ללקוח את השורות האלה. מקלידים כל אחת בחייגן ולוחצים חיוג.',
    forwardWarn: 'ההעברה מחליפה את התא הקולי. ##002# מבטל את כל ההעברות.',
    lastCall: (when) => `השיחה האחרונה שהגיעה לעוזר: ${when}.`,
    noCall: 'עוד לא הגיעה שיחה לעוזר. כשהלקוח מפעיל את ההעברה, כדאי שמישהו יתקשר אליו ולא יענה, כדי לראות שזה עובד.',
    status: 'מצב',
    activate: 'להפעיל',
    pause: 'לעצור',
    stop: 'הלקוח הפסיק',
    activated: 'העוזר פעיל. מעכשיו הוא כותב למי שמתקשר ולא נענה.',
    paused: 'העוזר עצור.',
    stopped: 'סומן שהלקוח הפסיק. השיחות שלו יימחקו בעוד 30 יום.',
  },
  skips: { title: 'לא לשלוח אל', hint: 'מספרים שהעוזר לא כותב אליהם: משפחה, ספקים, מי שביקש להסיר. הלקוח יכול גם לכתוב לעוזר "לא לשלוח ל־05X...".', add: 'להוסיף', remove: 'להוציא', none: 'אין מספרים ברשימה.', why: { owner: 'הלקוח ביקש', admin: 'הוספתי', stopped: 'ביקשו להסיר' } },
  chats: { title: 'שיחות אחרונות', none: 'עוד אין שיחות.', calls: (n) => (n > 1 ? `${n} שיחות` : 'שיחה אחת') },
  end: { title: 'מחיקה', remove: 'למחוק את הלקוח', sure: 'כן, למחוק', hint: 'הלקוח, השיחות וההודעות שלו נמחקים, וגם צילומי ההעברות. רישומי התשלום נשארים 7 שנים, כמו שחוק המס מחייב. את המספר ב־Telnyx מבטלים שם.', done: 'הלקוח נמחק.' },
};

// ---- Paying (docs/payments.md): to the customer from the business number, and the admin's pages.
//
// PAY.message is the template alhakav_payment's body, filled in (docs/whatsapp-templates.md); its {{1}} is one of
// PAY.lines, {{2}} the amount, {{3}} PAYMENT_DETAILS. A variable never has a line break in it.

export const PAY = {
  message: ({ line, amount, details }) => `שלום, כאן על הקו. ${line}\n\nלתשלום: ${amount} ₪ כולל מע״מ, בהעברה בנקאית: ${details}\n\nאחרי ההעברה שולחים כאן צילום מסך או PDF של האישור, ונעדכן כשהתשלום הגיע.`,
  lines: {
    first: ({ business, from, until }) => `זה התשלום על החודש הראשון של העוזר של ${business}, מ־${from} עד ${until}.`,
    soon: ({ business, paidUntil, from, until }) => `העוזר של ${business} משולם עד ${paidUntil}. זה התשלום על החודש הבא, מ־${from} עד ${until}.`,
    due: ({ business, paidUntil, graceUntil }) => `החודש ששולם על העוזר של ${business} נגמר ב־${paidUntil}. העוזר ממשיך לעבוד עד סוף ${graceUntil}, ואם התשלום לא יגיע עד אז, הוא ייעצר עד שיגיע.`,
    last: ({ business }) => `העוזר של ${business} עובד עד סוף היום. אם התשלום על החודש החדש לא יגיע עד אז, הוא ייעצר עד שיגיע.`,
    stopped: ({ business, since }) => `העוזר של ${business} עצור מ־${since}, כי התשלום על החודש החדש לא הגיע. כשהתשלום יגיע, העוזר יחזור לעבוד.`,
  },
  received: 'קיבלנו את האישור, תודה. נבדוק מול הבנק ונעדכן כאן.',
  again: 'את האישור הזה כבר קיבלנו. נעדכן כאן כשנבדוק מול הבנק.',
  againPaid: 'את האישור הזה כבר קיבלנו, והתשלום נרשם.',
  unreadable: 'לא הצלחנו לפתוח את הקובץ. אפשר לשלוח אותו שוב, כתמונה או כקובץ PDF?',
  tooLarge: 'הקובץ גדול מדי. אפשר לשלוח צילום מסך של האישור?',
  paid: ({ business, until, url }) => `התשלום הגיע, תודה. העוזר של ${business} משולם עד ${until}.${url ? `\n\nהחשבונית: ${url}` : ''}`,
  invoice: {
    description: 'על הקו, עוזר לשיחות שלא נענו',
    row: (from, until) => `על הקו, ${from} עד ${until}`,
    email: 'קיבלנו את התשלום על החודש, והחשבונית מצורפת.',
  },
  state: {
    new: 'עוד לא שילמו',
    paid: (until) => `משולם עד ${until}`,
    grace: (until) => `החודש נגמר. עובד עד סוף ${until}`,
    lapsed: 'עצור: לא שולם',
    free: 'בלי תשלום',
    ending: (until) => `מפסיק אחרי ${until}`,
    ended: 'הפסיק',
  },
  admin: {
    title: 'תשלום',
    noDetails: '[פרטי החשבון]',
    sum: ({ total, net, vat, from, until }) => `${total} ₪ כולל מע״מ (${net} ₪ ועוד ${vat} ₪ מע״מ), על ${from} עד ${until}`,
    owed: (sum) => `לתשלום עכשיו: ${sum}.`,
    nothing: 'אין מה לשלם עכשיו.',
    offNew: 'העוזר לא כותב למתקשרים עד שהתשלום הראשון נרשם.',
    offLapsed: 'העוזר לא כותב למתקשרים עד שהתשלום נרשם.',
    preview: 'ההודעה שתישלח',
    ask: 'לשלוח בקשת תשלום בוואטסאפ',
    asked: 'בקשת התשלום נשלחה.',
    manual: 'התקבל תשלום',
    manualHint: 'רושם את החודש שלמעלה בלי צילום, כשהכסף הגיע בדרך אחרת. בדקו בבנק לפני.',
    manualDone: (until) => `התשלום נרשם. משולם עד ${until}.`,
    end: 'להפסיק בסוף החודש ששולם',
    endHint: 'כמו בתנאי השימוש: העוזר עובד עד סוף החודש ששולם, ואז נעצר, ולא נשלחות יותר בקשות תשלום.',
    ended: (until) => `העוזר יפסיק אחרי ${until}.`,
    unend: 'לבטל את ההפסקה',
    unended: 'ההפסקה בוטלה.',
    receipts: 'תשלומים ואישורים',
    noReceipts: 'עוד אין.',
    notices: 'הודעות התשלום שנשלחו',
    noticeKind: { ask: 'בקשה ששלחתי', soon: 'לפני סוף החודש', due: 'אחרי סוף החודש', last: 'היום האחרון', stopped: 'אחרי שנעצר' },
    noticeStatus: { sent: 'נשלחה', failed: 'לא נשלחה' },
    chat: 'השיחה בוואטסאפ של העסק',
    billing: 'פרטים לחשבונית',
    fields: { price: 'מחיר לחודש, לפני מע״מ', invoice_name: 'השם בחשבונית', tax_id: 'מספר עוסק או ח״פ', address: 'כתובת', email: 'מייל לחשבונית', free: 'בלי תשלום (פיילוט)' },
    billingBad: 'המחיר או המייל לא תקינים.',
    blocked: { meta: 'המספר של העסק לא מחובר (META_TOKEN ו־META_PHONE_ID).', details: 'חסרים פרטי החשבון להעברה (PAYMENT_DETAILS).', nothing: 'אין מה לשלם עכשיו.', stopped: 'הם ביקשו שלא נכתוב להם מהמספר של העסק.', failed: 'Meta לא שלח את ההודעה.' },
    errors: { already_paid: 'התשלום כבר נרשם, מכאן או מאישור אחר. רעננתי את הדף.', nothing_due: 'אין חודש לרשום עכשיו.', decided: 'כבר החלטתם על האישור הזה.', no_receipt: 'האישור הזה לא קיים.', no_customer: 'הלקוח של האישור הזה נמחק.' },
  },
  receipt: {
    title: 'אישור העברה',
    waiting: 'אישורי העברה שמחכים',
    from: (phone) => `נשלח מ־${phone}`,
    manual: 'נרשם ידנית, בלי צילום',
    owedThen: (sum) => `כשהגיע, היה לתשלום ${sum}.`,
    owedNow: (sum) => `לתשלום היום: ${sum}.`,
    pending: 'מחכה לבדיקה',
    check: 'בדקו בבנק שההעברה הגיעה לפני שמאשרים.',
    paid: 'התשלום הגיע',
    notPaid: 'לא הגיע',
    notPaidHint: 'לא נרשם כלום, ולא נשלחת הודעה. גם כשזה לא אישור העברה, או אישור של תשלום שכבר נרשם.',
    decided: { paid: (until) => `התשלום נרשם. משולם עד ${until}.`, not_paid: 'סומן שלא הגיע. לא נרשם תשלום.' },
    noFile: 'הקובץ נמחק, 90 יום אחרי שהגיע.',
    openPdf: 'לפתוח את ה־PDF',
    image: 'צילום האישור',
  },
  morning: {
    off: 'החשבונית לא הופקה אוטומטית: Morning לא מחובר (MORNING_CLIENT_ID ו־MORNING_CLIENT_SECRET).',
    issuing: 'Morning מפיק עכשיו את החשבונית. רעננו את הדף בעוד רגע.',
    issued: (number) => `Morning הפיק חשבונית מס קבלה ${number}.`,
    open: 'לפתוח ב־Morning',
    failed: (why, code) => `לא הצלחנו להפיק חשבונית. ${why} (קוד ${code})`,
    said: (text) => `Morning כתב: ${text}`,
    blocked: (why) => `לא הפקנו חשבונית. ${why} התשלום כבר נרשם.`,
    retry: 'להפיק חשבונית שוב',
    maybe: 'ייתכן שהחשבונית בכל זאת הופקה. בדקו ב־Morning לפני שמפיקים שוב.',
    why: {
      timeout: 'Morning לא ענה בזמן.',
      unreachable: 'לא הצלחנו להגיע ל־Morning.',
      invalid_client: 'Morning לא קיבל את המפתחות (MORNING_CLIENT_ID ו־MORNING_CLIENT_SECRET).',
      invalid_grant: 'Morning לא קיבל את המפתחות (MORNING_CLIENT_ID ו־MORNING_CLIENT_SECRET).',
      unauthorized_client: 'בחבילה של Morning אין גישה ל־API. צריך חבילה שכוללת אותה.',
      1006: 'צריך לחדש את המנוי ב־Morning.',
      1010: 'Morning קיבל את הבקשה הזאת פעמיים. בדקו שם אם החשבונית כבר הופקה.',
      1012: 'הפעולה הזאת צריכה חבילה גבוהה יותר ב־Morning.',
      1018: 'Morning לא קיבל את כתובת המייל של הלקוח.',
      1019: 'Morning לא קיבל את כתובת המייל של הלקוח.',
      bad_answer: 'Morning ענה תשובה שלא הבנו.',
      other: 'Morning החזיר שגיאה.',
    },
    blockedWhy: {
      exempt: 'ב־Morning העסק מוגדר כפטור ממע״מ, אבל בתשלום נוסף מע״מ. מתקנים את ההגדרה ב־Morning, ואז מפיקים שוב.',
      vat_rate: (rate) => `שיעור המע״מ ב־Morning הוא ${rate}, ואצלנו 18%. מתקנים את ההגדרה ב־Morning, ואז מפיקים שוב.`,
      vat_unknown: 'Morning לא אמר מה שיעור המע״מ אצלו, אז אי אפשר לבדוק שהחשבונית תהיה נכונה.',
    },
    flash: { issued: (n) => `Morning הפיק חשבונית מס קבלה ${n}.`, failed: 'החשבונית לא הופקה. הפרטים בדף של האישור.' },
  },
};

// ---- The admin's alerts on their own WhatsApp (alerts.js), through Toran. A title the phone shows, and a body with
// what happened and the page to open.

export const ALERT = {
  fresh: (who) => `על הקו: הודעה חדשה מ־${who}`,
  yes: (who) => `על הקו: ${who} ביקשו את ההסבר`,
  join: (who) => `על הקו: ${who} רוצים להצטרף, ופרטי התשלום נשלחו אליהם`,
  joinFailed: (who) => `על הקו: ${who} רוצים להצטרף, אבל פרטי התשלום לא נשלחו`,
  handoff: (who) => `על הקו: תורן העביר אליך את ${who}`,
  receipt: (who) => `על הקו: ${who} שלחו צילום של העברה`,
  quiet: (who) => `על הקו: תורן לא ענה ל־${who}`,
  body: {
    open: (link) => `הדף שלהם: ${link}`,
    check: (link) => `לבדוק מול הבנק ולאשר: ${link}`,
    answer: (link) => `צריך לענות להם מהדף שלהם: ${link}`,
    joinWhy: {
      meta: 'השליחה מהמספר של העסק לא מחוברת.',
      details: 'פרטי החשבון להעברה לא מוגדרים (PAYMENT_DETAILS).',
      nothing: 'אין להם מה לשלם עכשיו.',
      stopped: 'הם ביקשו שלא נכתוב להם.',
      failed: 'Meta לא שלח את ההודעה.',
      customer: 'לא נפתח להם כרטיס לקוח, כנראה כי המספר שלהם לא נייד ישראלי.',
    },
  },
};
