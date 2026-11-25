// Asking us to stop, in the words people use, ported as it is from openfrequency-toran's src/core/stopWords.ts (the
// owner there, 2026-11-17: "מהר הסר" was answered as a question and "חאלס", twice, with the link once more). A short
// message counts when, once the small words around the ask are taken away, all that is left is the ask itself:
//
//   asksRemoval   "remove me": הסר, הסירו, להסיר, stop, unsubscribe; תורידו, תמחקו only with their "me" or "from the
//                 list"; a "don't" before writing or sending ("אל תכתבו לי"), or "stop" before it
//   asksToStop    that, or "enough" alone: די, מספיק, חאלס, תפסיקו, עזבו, ספאם. We always wrote first here, so either
//                 one stops us
//
// And the automatic answers a business's WhatsApp sends by itself (an away message, a greeting, a bot), from
// openfrequency-toran's src/channels/pace.ts: kept in the chat, never counted as the tradesperson answering.

const REMOVE = new Set(['הסר', 'הסירו', 'הסירי', 'תסירו', 'תסיר', 'תסירי', 'להסיר', 'הסרה', 'stop', 'unsubscribe', 'unsub', 'remove', 'removed']);
const TAKE_OFF = new Set(['תורידו', 'תוריד', 'תורידי', 'הורידו', 'להוריד', 'תוציאו', 'תוציא', 'הוציאו', 'להוציא', 'תמחקו', 'תמחק', 'תמחקי', 'מחקו', 'למחוק']);
const OBJECT = new Set(['אותי', 'אותנו', 'המספר', 'מהרשימה', 'מהרשימות', 'מרשימת', 'מהתפוצה', 'מהדיוור', 'מההודעות', 'מהקבוצה', 'me', 'us']);
const SEND = new Set(['תכתבו', 'תכתוב', 'תכתבי', 'לכתוב', 'תשלחו', 'תשלח', 'תשלחי', 'לשלוח', 'תפנו', 'לפנות', 'תתקשרו', 'להתקשר', 'תטרידו', 'להטריד', 'להציק', 'תציקו', 'write', 'send', 'message', 'text', 'contact']);
const NEGATION = new Set(['אל', 'לא', "don't", 'dont', 'never']);
const ENOUGH = new Set(['די', 'מספיק', 'חאלס', 'חלאס', "ח'לאס", 'ח׳לאס', 'תפסיקו', 'תפסיק', 'תפסיקי', 'הפסיקו', 'להפסיק', 'עזבו', 'עזוב', 'עזבי', 'תעזבו', 'תעזוב', 'ספאם', 'spam', 'enough']);
const FILLER = new Set([
  'בבקשה', 'מהר', 'דחוף', 'תודה', 'כבר', 'נו', 'עכשיו', 'מיד', 'מייד', 'את', 'שלי', 'שלנו', 'הזה', 'הזאת', 'מכאן', 'מפה', 'פה',
  'לי', 'לנו', 'אני', 'אנחנו', 'רוצה', 'רוצים', 'מבקש', 'מבקשת', 'מבקשים', 'אפשר', 'יותר', 'שוב', 'עוד', 'הודעות', 'ההודעות',
  'הודעה', 'זה', 'רק', 'גם', 'באמת', 'אחי', 'המספר', 'הזו', 'כאן', 'כל', 'אלינו', 'אליי', 'אלי', 'עצמי', 'שלכם', 'אצלכם',
  'please', 'pls', 'plz', 'now', 'asap', 'from', 'the', 'this', 'list', 'my', 'number', 'just', 'thanks', 'thank', 'you', 'your', 'ok', 'and', 'any', 'more',
  'messages', 'to', 'i', 'want', 'wanna', 'be', 'of',
  ...NEGATION,
  ...OBJECT,
]);

function ask(text) {
  const words = String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'׳]+/gu, ' ')
    .split(' ')
    .map((w) => w.replace(/^['׳]+|['׳]+$/g, ''))
    .filter(Boolean);
  if (!words.length || words.length > 10) return null;
  const has = (set) => words.some((w) => set.has(w));
  const object = has(OBJECT);
  const negation = has(NEGATION);
  // A word with its "ו" ("ותסירו", "ודי") is the word.
  const kind = (w) => {
    if (REMOVE.has(w) || (object && TAKE_OFF.has(w))) return 'remove';
    if (SEND.has(w)) return 'send';
    if (ENOUGH.has(w)) return 'enough';
    if (FILLER.has(w)) return 'filler';
    return w.length > 2 && w.startsWith('ו') ? kind(w.slice(1)) : null;
  };
  const kinds = words.map(kind);
  if (kinds.includes(null)) return null;
  const enough = kinds.includes('enough');
  const removal = kinds.includes('remove') || (kinds.includes('send') && (negation || enough));
  const stop = removal || (enough && !kinds.includes('send'));
  return removal || stop ? { removal, stop } : null;
}

export const asksRemoval = (text) => Boolean(ask(text)?.removal);
export const asksToStop = (text) => Boolean(ask(text)?.stop);

const AUTO_WORDS = /שעות (?:ה)?פעילות|פעיל(?:ה|ים)? בין השעות|שירות הלקוחות (?:שלנו )?(?:פעיל|זמין)|(?:נחזור|נענה|נשוב|נחזיר|אחזור) (?:אלי(?:ך|יך|כם)|לך|לכם|בהקדם|תשובה)|קיבלנו את (?:פנייתך|פנייתכם|הפנייה|הודעתך|ההודעה)|תודה (?:על פנייתך|על פנייתכם|על הפנייה|שפנית|שפניתם|שכתבת|שכתבתם)|השארת לנו (?:פנייה|הודעה)|ספרו לנו במה (?:אפשר|נוכל) לעזור|(?:במה|איך) (?:אפשר|נוכל|אוכל) לעזור|כרטיס (?:ה)?ביקור|הודעה אוטומטית|מענה אוטומטי|ימי עסקים|אינו מאויש|מחוץ לשעות/;
const BOT_WORDS = /אני (?:ה)?(?:בוט|צ'?אט ?בוט|עוזר(?:ת)? (?:ה)?(?:וירטואלי|דיגיטלי|אוטומטי|חכם)(?:ת)?|נציג(?:ה)? (?:ה)?(?:וירטואלי|דיגיטלי|אוטומטי)(?:ת)?)|(?:מופעל|מופעלת) (?:על ידי|ע"י|ע״י|באמצעות)|\b(?:i am|i'm) (?:an? )?(?:ai|virtual|digital|automated) (?:assistant|agent)\b|\bthis is an automated (?:message|reply|response)\b/i;

/** A message their phone sent by itself: an away message, a greeting, or a bot. */
export const automatic = (text) => AUTO_WORDS.test(String(text || '')) || BOT_WORDS.test(String(text || ''));
