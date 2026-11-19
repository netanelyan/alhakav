import { TRADE } from './copy.js';
import { local } from './phones.js';

// How good a lead a site is for על הקו, out of 100, with every factor's points and the evidence behind them kept, as
// openfrequency-toran's src/leads/score.ts does for stores.
//
// Who על הקו is for: one plumber, electrician, AC technician or locksmith who answers their own mobile, works in one
// area, and loses a job each time a call rings out while their hands are full. Not a call centre, a chain or a
// directory, which have someone on the phone already.
//
//   trade     25  one of the four
//   mobile    30  a mobile on the site; a landline only 5
//   whatsapp  10  a WhatsApp link to their number 10, a WhatsApp button with no number in the page 5
//   local     15  one to three cities named 15; four to seven 8; none named 5; eight or more 0
//   hebrew    10  60%+ of the letters Hebrew 10, 25%+ 5
//   alive      5  © this year or last 5; an older year 0; no year 2
//   owner      5  written by a person about their own work ("שמי", "אני מגיע")
//   chain    -40  a call centre, branches, "בכל הארץ", or eight or more cities
//   special  -15  a 1-700, 1-800 or *XXXX number
//
// Rejected outright, whatever the score: a directory (six or more mobiles), a site not in Hebrew, none of the four
// trades, and no mobile, since a mobile is the only number we write to. Qualified: no rejection and 55 or more.

export const QUALIFY_AT = 55;

export function scoreLead(d, at = Date.now()) {
  const b = [];
  const add = (factor, points, max, evidence) => b.push({ factor, points, max, evidence });

  add('trade', d.trade ? 25 : 0, 25, d.trade ? `${TRADE[d.trade]}, ${d.tradeHits} אזכורים` : 'לא נמצא אחד מארבעת המקצועות');

  if (d.mobile) add('mobile', 30, 30, `נייד באתר: ${local(d.mobile)}`);
  else if (d.others.length) add('mobile', 5, 30, `רק קו נייח: ${local(d.others[0])}`);
  else add('mobile', 0, 30, 'אין טלפון באתר');

  if (d.whatsappLinked) add('whatsapp', 10, 10, 'קישור לוואטסאפ עם המספר');
  else if (d.waWidget) add('whatsapp', 5, 10, 'כפתור וואטסאפ בלי מספר בדף');
  else add('whatsapp', 0, 10, 'אין וואטסאפ באתר');

  const n = d.cities.length;
  if (n === 0) add('local', 5, 15, 'לא כתובה עיר');
  else if (n <= 3) add('local', 15, 15, d.cities.join(', '));
  else if (n <= 7) add('local', 8, 15, `${n} ערים: ${d.cities.slice(0, 3).join(', ')} ועוד`);
  else add('local', 0, 15, `${n} ערים באתר`);

  const he = d.hebrew;
  add('hebrew', he >= 0.6 ? 10 : he >= 0.25 ? 5 : 0, 10, `${Math.round(he * 100)}% מהאותיות בעברית`);

  const year = new Date(at).getUTCFullYear();
  if (d.year) add('alive', d.year >= year - 1 ? 5 : 0, 5, `© ${d.year}`);
  else add('alive', 2, 5, 'לא כתובה שנה');

  add('owner', d.ownerVoice ? 5 : 0, 5, d.ownerVoice ? 'כתוב בגוף ראשון, כמו אדם אחד' : 'לא כתוב בגוף ראשון');

  if (d.chain) add('chain', -40, 0, `נראה כמו מוקד או רשת: ${d.chain}`);
  if (d.specials.length) add('special', -15, 0, `מספר של מוקד: ${d.specials[0]}`);

  const score = Math.max(0, b.reduce((s, f) => s + f.points, 0));

  let reject = null;
  if (d.directory) reject = `אתר של רשימות, לא של בעל מקצוע אחד (${d.directory})`;
  else if (he < 0.15 && !d.lang?.startsWith('he') && d.dir !== 'rtl') reject = 'האתר לא בעברית';
  else if (!d.trade) reject = 'לא אינסטלטור, חשמלאי, טכנאי מזגנים או מנעולן';
  else if (!d.mobile) reject = 'אין נייד באתר, אז אין לאן לכתוב בוואטסאפ';

  return { score, breakdown: b, qualified: !reject && score >= QUALIFY_AT, reject };
}
