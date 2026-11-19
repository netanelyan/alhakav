import assert from 'node:assert/strict';
import { test } from 'node:test';
import { afterQuiet, israelHoliday, quiet, whenHe } from '../server/clock.js';
import { citiesIn, detect, siteKey } from '../server/detect.js';
import { privateAddress } from '../server/fetcher.js';
import { isMobile, local, normalize, phonesIn } from '../server/phones.js';
import { scoreLead } from '../server/score.js';
import { notABusiness, queriesFor } from '../server/sources.js';
import { asksToStop, automatic } from '../server/stopWords.js';
import { detected, fixture } from './helpers.js';

test('Israeli numbers come out the way WhatsApp writes them', () => {
  assert.equal(normalize('054-123-4567'), '972541234567');
  assert.equal(normalize('+972 54 123 4567'), '972541234567');
  assert.equal(normalize('00972-54-1234567'), '972541234567');
  assert.equal(normalize('08-8561234'), '97288561234');
  assert.equal(normalize('1-700-50-50-50'), null);
  assert.equal(normalize('12345'), null);
  assert.ok(isMobile('972541234567'));
  assert.ok(!isMobile('97288561234'));
  assert.ok(!isMobile('972721234567'), 'a 07X line is not a mobile');
  assert.equal(local('972541234567'), '054-123-4567');
  assert.equal(local('97288561234'), '08-856-1234');
});

test('a page gives its mobiles, its other lines, its WhatsApp number and its call-centre numbers', () => {
  const p = phonesIn('<a href="https://api.whatsapp.com/send?phone=972521112233&amp;text=hi">x</a><a href="tel:+97236001234">x</a>', 'או 050 999 8877 או *2580 או 1-800-20-20-20');
  assert.deepEqual(p.whatsapp, ['972521112233']);
  assert.deepEqual(p.mobiles.sort(), ['972509998877', '972521112233']);
  assert.deepEqual(p.others, ['97236001234']);
  assert.deepEqual(p.specials.sort(), ['*2580', '1-800-20-20-20'].sort());
});

test("a plumber's own site: the trade, the city, the number to write to, and a full score", () => {
  const d = detected('plumber');
  assert.equal(d.trade, 'plumber');
  assert.equal(d.name, 'אבי אינסטלציה');
  assert.equal(d.city, 'אשדוד');
  assert.deepEqual(d.cities, ['אשדוד', 'אשקלון', 'יבנה']);
  assert.equal(d.mobile, '972541234567');
  assert.ok(d.whatsappLinked);
  assert.deepEqual(d.others, ['97288561234']);
  assert.deepEqual(d.specials, [], 'a number inside a script is not on the page');
  assert.ok(d.ownerVoice);
  assert.equal(d.year, 2026);
  const s = scoreLead(d, Date.parse('2026-11-19T10:00:00Z'));
  assert.equal(s.reject, null);
  assert.ok(s.qualified);
  assert.equal(s.score, 100);
});

test('a directory, a chain and a bakery are told apart from a tradesperson', () => {
  const dir = scoreLead(detected('directory'));
  assert.match(dir.reject, /רשימות/);
  const chain = scoreLead(detected('chain'));
  assert.equal(chain.reject, null);
  assert.ok(!chain.qualified, `a chain scores under the bar (${chain.score})`);
  assert.ok(chain.breakdown.some((f) => f.factor === 'chain' && f.points < 0));
  assert.ok(chain.breakdown.some((f) => f.factor === 'special' && f.points < 0));
  assert.match(scoreLead(detected('bakery')).reject, /לא אינסטלטור/);
});

test('cities are found with their prefixes, and not inside other words', () => {
  assert.deepEqual(citiesIn('עובד באשדוד ובאשקלון, וגם לחיפה'), ['אשדוד', 'אשקלון', 'חיפה']);
  assert.deepEqual(citiesIn('הגדרה של המונח'), [], '"גדרה" inside "הגדרה" is not Gedera');
  assert.deepEqual(citiesIn('קרית גת'), ['קריית גת'], 'a variant spelling is reported as the main one');
});

test('a home page with no mobile sends us to its contact page', async () => {
  const pages = {
    'https://noam.example/': '<html lang="he"><title>נועם חשמל | חשמלאי ברחובות</title><body><h1>חשמלאי מוסמך</h1><a href="/contact">צור קשר</a></body></html>',
    'https://noam.example/contact': '<html lang="he"><body>חשמלאי, לוח חשמל, הארקות. נייד 052-765-4321</body></html>',
  };
  const fetcher = async (url) => ({ url, status: 200, text: pages[url] });
  const d = await detect('https://noam.example/', { fetcher });
  assert.equal(d.trade, 'electrician');
  assert.equal(d.mobile, '972527654321');
  assert.equal(d.city, 'רחובות');
});

test('one site per business, and a site builder keeps its first path segment', () => {
  assert.equal(siteKey('https://www.avi-plumbing.co.il/about'), 'avi-plumbing.co.il');
  assert.equal(siteKey('https://avi123.wixsite.com/avi-plumbing/contact'), 'avi123.wixsite.com/avi-plumbing');
  assert.equal(siteKey('ftp://x.co.il'), null);
  assert.ok(notABusiness('b144.co.il'));
  assert.ok(notABusiness('www.facebook.com'.replace(/^www\./, '')));
  assert.ok(notABusiness('jerusalem.muni.il'));
  assert.ok(!notABusiness('avi-plumbing.co.il'));
});

test('the searches rotate by day through trades and cities', () => {
  const a = queriesFor(0, 3);
  assert.deepEqual(a.map((q) => q.q), ['אינסטלטור באשדוד', 'חשמלאי באשדוד', 'טכנאי מזגנים באשדוד']);
  assert.equal(queriesFor(1, 3)[0].q, 'מנעולן באשדוד');
  assert.deepEqual(queriesFor(5, 2, { trade: 'locksmith', city: 'חולון' }).map((q) => q.q), ['מנעולן זמין בחולון', 'מנעולן מומלץ בחולון']);
});

test('the fetcher refuses this machine and private networks', () => {
  for (const ip of ['127.0.0.1', '10.0.0.8', '192.168.1.1', '172.20.0.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:127.0.0.1', 'not-an-ip']) assert.ok(privateAddress(ip), ip);
  for (const ip of ['8.8.8.8', '104.16.0.1', '2606:4700::1111']) assert.ok(!privateAddress(ip), ip);
});

test('quiet hours: nights, Friday afternoon, Shabbat and Yom Kippur', () => {
  // November is UTC+2 in Israel; September UTC+3.
  assert.ok(!quiet(Date.parse('2026-11-22T08:00:00Z')), 'Sunday 10:00');
  assert.ok(quiet(Date.parse('2026-11-19T18:30:00Z')), 'Thursday 20:30');
  assert.ok(quiet(Date.parse('2026-11-20T06:00:00Z')), 'Friday 08:00');
  assert.ok(!quiet(Date.parse('2026-11-20T09:00:00Z')), 'Friday 11:00');
  assert.ok(quiet(Date.parse('2026-11-20T12:00:00Z')), 'Friday 14:00');
  assert.ok(quiet(Date.parse('2026-11-21T10:00:00Z')), 'Saturday noon');
  assert.ok(israelHoliday(Date.parse('2026-09-21T09:00:00Z')), 'Yom Kippur 5787');
  assert.ok(quiet(Date.parse('2026-09-21T09:00:00Z')));
  assert.ok(quiet(Date.parse('2026-09-20T11:00:00Z')), 'the afternoon before Yom Kippur');
  assert.ok(!quiet(Date.parse('2026-09-22T09:00:00Z')), 'the Tuesday after');
  const sat = Date.parse('2026-11-21T10:00:00Z');
  assert.equal(new Date(afterQuiet(sat)).toISOString(), '2026-11-22T07:00:00.000Z', 'Sunday 09:00');
  assert.equal(whenHe(afterQuiet(sat), sat), 'מחר ב־09:00');
});

test('asking us to stop, in the words people use, and an automatic answer', () => {
  for (const t of ['הסר', 'מהר הסר', 'חאלס', 'די', 'אל תכתבו לי יותר', 'תורידו אותי מהרשימה', 'STOP']) assert.ok(asksToStop(t), t);
  for (const t of ['כן', 'כמה זה עולה?', 'תוריד את המחיר', 'אפשר לשמוע עוד']) assert.ok(!asksToStop(t), t);
  assert.ok(automatic('תודה על פנייתך, נחזור אליך בהקדם'));
  assert.ok(automatic('שעות הפעילות שלנו הן 8:00-17:00'));
  assert.ok(!automatic('כן, תשלחו פרטים'));
});

test('fixtures are read as a browser would: the plumber page is Hebrew and right to left', () => {
  assert.match(fixture('plumber'), /dir="rtl"/);
});
