// One clock for the whole server, so the tests can move time (Shabbat, the reminder's four days, the 24 hours in which
// WhatsApp lets us answer) without waiting for it. Ported from openfrequency-toran's src/core/clock.ts.

let fixed = null;

export const now = () => fixed ?? Date.now();
export const nowIso = (t = now()) => new Date(t).toISOString();
export const setNow = (t) => {
  fixed = t == null ? null : new Date(t).getTime();
};

export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

const TZ = 'Asia/Jerusalem';

/** The calendar date in Israel, YYYY-MM-DD. */
export function israelDate(t = now()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
}

/** The days since 1970 by Israel's calendar: what rotates the daily searches. */
export const dayNumber = (t = now()) => Math.floor(Date.parse(israelDate(t)) / DAY);

/** Weekday in Israel (0 = Sunday ... 6 = Saturday), hour, minute, day of the month and month. */
export function israelParts(t = now()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'numeric', hourCycle: 'h23' })
      .formatToParts(new Date(t))
      .map((x) => [x.type, x.value])
  );
  return { weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday), hour: Number(p.hour), minute: Number(p.minute), day: Number(p.day), month: Number(p.month) };
}

// ---- When a tradesperson is not written to: the night, Shabbat and the holidays.
//
// Toran waits from 21:00 to 09:00; a plumber's own mobile gets less, 20:00 to 09:00, since it is the phone they work
// on. Shabbat and the holidays as in Toran: from 13:00 on the eve until the night after (candle lighting is never before
// 13:00 and nightfall never after 21:00 here, so fixed hours hold the whole of it without working out sunset). The
// holidays are Israel's days of rest, one day each as in Israel, read from the Hebrew calendar Intl already has.

export const OPEN_FROM = 9;
export const OPEN_UNTIL = 20;

const YOM_TOV = new Set(['1 Tishri', '2 Tishri', '10 Tishri', '15 Tishri', '22 Tishri', '15 Nisan', '21 Nisan', '6 Sivan']);
const HEBREW = new Intl.DateTimeFormat('en-u-ca-hebrew', { timeZone: TZ, day: 'numeric', month: 'long' });

/** Is this day, in Israel, a holiday on which work stops? */
export function israelHoliday(t = now()) {
  const p = HEBREW.formatToParts(new Date(t));
  return YOM_TOV.has(`${p.find((x) => x.type === 'day')?.value} ${p.find((x) => x.type === 'month')?.value}`);
}

/** Is it a time a tradesperson is not written to? */
export function quiet(t = now()) {
  const { weekday, hour } = israelParts(t);
  if (hour < OPEN_FROM || hour >= OPEN_UNTIL) return true;
  if (weekday === 6 || israelHoliday(t)) return true;
  return hour >= 13 && (weekday === 5 || israelHoliday(t + DAY));
}

/** The first whole hour from t that is not quiet (t itself when it is not). */
export function afterQuiet(t = now()) {
  let x = t;
  // Rosh Hashana beside Shabbat is the longest stretch, three days and their nights; eight days is far past it.
  for (let i = 0; i < 24 * 8 && quiet(x); i++) x = Math.floor(x / HOUR) * HOUR + HOUR;
  return x;
}

// ---- Times as the admin pages say them

const WEEKDAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const HHMM = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

export const hhmm = (t) => HHMM.format(new Date(t));

/** "19.11" */
export function dayMonth(t) {
  const p = israelParts(t);
  return `${p.day}.${p.month}`;
}

/** "היום ב־14:00", "מחר ב־09:00", "ביום ראשון ב־09:00", "ב־3.12 ב־09:00". */
export function whenHe(t, at = now()) {
  const d = israelDate(t);
  const day = d === israelDate(at) ? 'היום' : d === israelDate(at + DAY) ? 'מחר' : t - at < 6 * DAY ? `ביום ${WEEKDAYS[israelParts(t).weekday]}` : `ב־${dayMonth(t)}`;
  return `${day} ב־${hhmm(t)}`;
}

/** "עכשיו", "לפני 5 דקות", "לפני שעתיים", "אתמול", "לפני 4 ימים". */
export function agoHe(t, at = now()) {
  const s = Math.max(0, at - t);
  if (s < 2 * MINUTE) return 'עכשיו';
  if (s < HOUR) return `לפני ${Math.round(s / MINUTE)} דקות`;
  if (s < 1.5 * HOUR) return 'לפני שעה';
  if (s < 2.5 * HOUR) return 'לפני שעתיים';
  if (s < DAY) return `לפני ${Math.round(s / HOUR)} שעות`;
  if (s < 2 * DAY) return 'אתמול';
  if (s < 3 * DAY) return 'לפני יומיים';
  return `לפני ${Math.round(s / DAY)} ימים`;
}
