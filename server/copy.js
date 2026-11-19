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
  // After "כן, שלחו": they wrote to us, so this goes as plain text, at once.
  pitch: (site) =>
    [
      'תודה. ככה זה עובד:',
      'כשאתם לא עונים לשיחה, מי שהתקשר מקבל מאיתנו הודעה בוואטסאפ מיד כשהשיחה נגמרת. אנחנו שואלים אותו מה קרה, איפה, ואם זה דחוף, ושולחים לכם סיכום אחד עם המספר שלו. את המחיר ואת השעה אתם סוגרים איתו בעצמכם.',
      '149 ₪ לחודש, לא כולל מע״מ. אין דמי הקמה, ומשלמים חודש בחודש.',
      site ? `ככה זה נראה: ${site}` : '',
      'רוצים לנסות על המספר שלכם? כתבו לנו כאן ונסביר מה צריך לעשות.',
    ]
      .filter(Boolean)
      .join('\n\n'),
  stopped: 'הסרנו את המספר שלכם, ולא נכתוב אליכם שוב.',
  senderMissing: '[שורת הזיהוי: שם העסק, שם מלא, כתובת ואתר]',
};

// ---- The admin pages

export const T = {
  brand: 'על הקו',
  nav: { leads: 'לידים', reached: 'פנינו אליהם', logout: 'לצאת' },
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
    kind: { first: 'ההודעה הראשונה', reminder: 'התזכורת', pitch: 'ההסבר, אחרי שאמרו כן', stopped: 'אחרי שביקשו להסיר', reply: '' },
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
    notes: 'הערות',
    notesSave: 'לשמור',
    closedAs: (why) => `סגור: ${why}.`,
    done: { replied: 'סימנתי שענו.', customer: 'סימנתי שהפכו ללקוחות.', later: (when) => `נחזור אליהם ${when}.`, lost: 'הליד נסגר.', skip: 'דילגתי עליהם.', reopen: 'הליד חזר לרשימה.', notes: 'ההערות נשמרו.', name: 'השם נשמר.' },
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
