import assert from 'node:assert/strict';
import { test } from 'node:test';
import { discover, rescore, startDiscovery } from '../server/discover.js';
import { addByHand } from '../server/leads.js';
import { places } from '../server/sources.js';
import { ENV, fixture, testApp } from './helpers.js';

// Leads from Google's listings (sources.js places, detect.js fromPlace) and from a Facebook group by hand
// (leads.js addByHand). The owner, 2026-11-22: "google businesses", "replies to people who seek a worker in
// facebook", and "the ones who have a website often have good utility".

const place = (id, over = {}) => ({
  id,
  displayName: { text: 'קובי אינסטלציה באשדוד' },
  formattedAddress: 'הרצל 15, אשדוד, ישראל',
  nationalPhoneNumber: '050-123-4567',
  googleMapsUri: `https://maps.google.com/?cid=${id}`,
  businessStatus: 'OPERATIONAL',
  types: ['plumber', 'service'],
  rating: 4.8,
  userRatingCount: 52,
  ...over,
});

/** Google's Places Text Search, faked: answers these places to every search, and keeps what it was asked. */
function fakePlaces(list) {
  const asked = [];
  const f = async (url, init = {}) => {
    asked.push({ url: String(url), headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
    return Response.json({ places: list });
  };
  return { f, asked };
}

const Q = [{ q: 'אינסטלטור באשדוד', trade: 'plumber', city: 'אשדוד' }];
const collect = async (gen) => {
  const out = [];
  for await (const c of gen) out.push(c);
  return out;
};

test("Google's listings: a business's own site is read, one with none is the listing, a closed one or a Facebook page is not a site", async () => {
  const g = fakePlaces([
    place('a', { websiteUri: 'https://www.kobi-plumbing.co.il/services?x=1' }),
    place('b'),
    place('c', { websiteUri: 'https://www.facebook.com/kobi.plumbing' }),
    place('d', { businessStatus: 'CLOSED_PERMANENTLY' }),
  ]);
  const out = await collect(places({ apiKey: 'gk', queries: Q, fetchImpl: g.f }));
  assert.deepEqual(
    out.map((c) => [c.url, c.key || null]),
    [
      ['https://www.kobi-plumbing.co.il/', null],
      ['https://maps.google.com/?cid=b', 'g:b'],
      ['https://maps.google.com/?cid=c', 'g:c'],
    ]
  );
  assert.equal(out[0].detail.place.phone, '972501234567');
  assert.equal(g.asked[0].url, 'https://places.googleapis.com/v1/places:searchText');
  assert.equal(g.asked[0].headers['x-goog-api-key'], 'gk');
  assert.match(g.asked[0].headers['x-goog-fieldmask'], /places\.nationalPhoneNumber/);
  assert.deepEqual(g.asked[0].body, { textQuery: 'אינסטלטור באשדוד', languageCode: 'he', regionCode: 'IL', pageSize: 20 });
});

test('a listing with no site is a lead from its Google page, below what a site of its own scores', async () => {
  const { app, db } = testApp();
  const g = fakePlaces([place('b'), place('e', { displayName: { text: 'השרברב' }, nationalPhoneNumber: '08-856-1234' }), place('f', { displayName: { text: 'Fix it' }, nationalPhoneNumber: '054-222-3344', types: ['service'], formattedAddress: 'רחובות, ישראל', userRatingCount: 1 })]);
  const r = await discover(app, places({ apiKey: 'gk', queries: Q, fetchImpl: g.f }), { source: 'google' });
  const b = db.get("SELECT * FROM leads WHERE domain = 'g:b'");
  assert.equal(b.name, 'קובי אינסטלציה באשדוד');
  assert.equal(b.mobile, '972501234567');
  assert.equal(b.city, 'אשדוד');
  assert.equal(b.url, 'https://maps.google.com/?cid=b');
  assert.equal(b.qualified, 1);
  assert.equal(b.score, 70, 'trade 25, mobile 30, local 15, hebrew 10, alive 5, no site -15');
  assert.match(b.breakdown, /אין לו אתר משלו/);
  // A landline only: nowhere to write.
  assert.match(db.get("SELECT reason FROM seen WHERE domain = 'g:e'").reason, /אין נייד בגוגל/);
  // The trade only from the search, an English name, one review: kept, under the bar.
  const f = db.get("SELECT * FROM leads WHERE domain = 'g:f'");
  assert.equal(f.qualified, 0);
  assert.equal(f.city, 'רחובות');
  assert.equal(r.stats.added, 2);
});

test("a site Google gave: read as any site, with Google's mobile when the site shows none, and its reviews", async () => {
  const pages = {
    'https://kobi.example/': fixture('plumber'),
    'https://nomobile.example/': '<html lang="he"><title>דני אינסטלציה | אינסטלטור בחולון</title><body><h1>אינסטלטור</h1>פתיחת סתימות, איתור נזילות. משרד 03-555-1234</body></html>',
  };
  const { app, db } = testApp({ fetchSite: async (url) => (pages[url] ? { url, status: 200, text: pages[url] } : { url, status: 404, text: '' }) });
  const g = fakePlaces([
    place('a', { websiteUri: 'https://kobi.example/' }),
    place('n', { websiteUri: 'https://nomobile.example/', nationalPhoneNumber: '052-765-4321' }),
    place('x', { websiteUri: 'https://down.example/', nationalPhoneNumber: '053-111-2222' }),
  ]);
  await discover(app, places({ apiKey: 'gk', queries: Q, fetchImpl: g.f }), { source: 'google' });
  const kobi = db.get("SELECT * FROM leads WHERE domain = 'kobi.example'");
  assert.equal(kobi.mobile, '972541234567', "the site's own number first");
  assert.equal(kobi.score, 100);
  assert.equal(kobi.source, 'google');
  const dani = db.get("SELECT * FROM leads WHERE domain = 'nomobile.example'");
  assert.equal(dani.mobile, '972527654321');
  assert.match(dani.breakdown, /נייד בגוגל/);
  assert.match(dani.breakdown, /52 ביקורות בגוגל/);
  assert.equal(dani.qualified, 1);
  // A site that does not open: the listing, and the site is remembered as failed.
  assert.equal(db.get("SELECT mobile FROM leads WHERE domain = 'g:x'").mobile, '972531112222');
  assert.equal(db.get("SELECT status FROM seen WHERE domain = 'down.example'").status, 'failed');
});

test('a shop is not a tradesperson: by its title, by its name on Google, or by Google calling it a store', async () => {
  const pages = { 'https://edior.example/': '<html lang="he"><title>חנות חשמל בהרצליה | אינסטלציה ואביזרים</title><body><h1>אינסטלציה, ברזים, סתימות</h1>אינסטלציה אינסטלציה פתיחת סתימות. 050-765-4321</body></html>' };
  const { app, db } = testApp({ fetchSite: async (url) => ({ url, status: 200, text: pages[url] || '' }) });
  const g = fakePlaces([
    place('s', { websiteUri: 'https://edior.example/' }),
    place('n', { displayName: { text: 'חנות האינסטלציה של יוסי' }, nationalPhoneNumber: '052-111-2233' }),
    place('h', { displayName: { text: 'ברזי השרון' }, types: ['hardware_store', 'store'], nationalPhoneNumber: '053-444-5566' }),
    place('ok', { displayName: { text: 'יוסי אינסטלציה' }, types: ['plumber', 'store'], nationalPhoneNumber: '054-777-8899' }),
  ]);
  await discover(app, places({ apiKey: 'gk', queries: Q, fetchImpl: g.f }), { source: 'google' });
  for (const key of ['edior.example', 'g:n', 'g:h']) assert.match(db.get('SELECT reason FROM seen WHERE domain = ?', key).reason, /נראה כמו חנות/, key);
  // A plumber Google also files as a store is still a plumber.
  assert.equal(db.get("SELECT qualified FROM leads WHERE domain = 'g:ok'").qualified, 1);
});

test('a business for cars, a handyman, or a page with no name but the trade is not a tradesperson to write to', async () => {
  const pages = {
    'https://electric.unrelated.example/': '<html lang="he"><title>חשמלאי - חשמלאי זמין</title><body><h1>חשמלאי זמין</h1>חשמלאי חשמלאי עבודות חשמל, צוות מומחים. 055-930-2129</body></html>',
    'https://carfix.example/': '<html lang="he"><title>חשמלאי רכב בהרצליה | יוסי</title><body><h1>חשמלאי רכב</h1>חשמלאי חשמלאי עבודות חשמל. 050-765-4321</body></html>',
  };
  const { app, db } = testApp({ fetchSite: async (url) => ({ url, status: 200, text: pages[url] || '' }) });
  const ac = [{ q: 'טכנאי מזגנים בהרצליה', trade: 'ac', city: 'הרצליה' }];
  const g = fakePlaces([
    place('car', { displayName: { text: 'אלכס חשמל רכב הרצליה' }, types: ['electrician'], nationalPhoneNumber: '052-111-2233' }),
    place('garage', { displayName: { text: 'כולבו רכב אבי' }, types: ['car_repair'], nationalPhoneNumber: '052-111-2234' }),
    place('handy', { displayName: { text: 'איצקו | הנדימן ושיפוצים' }, types: ['service'], nationalPhoneNumber: '052-111-2235' }),
    place('plumbs', { displayName: { text: 'משה אינסטלציה ושיפוצים' }, types: ['plumber'], nationalPhoneNumber: '052-111-2236' }),
    place('fitter', { displayName: { text: "גולצ'י מזגנים - הרכבת מזגנים" }, types: ['service'], nationalPhoneNumber: '052-111-2237' }),
    place('keys', { displayName: { text: 'דני מנעולן - פריצת רכב ודלתות' }, types: ['locksmith'], nationalPhoneNumber: '052-111-2238' }),
    place('site1', { websiteUri: 'https://electric.unrelated.example/', nationalPhoneNumber: '055-930-2129' }),
    place('site2', { websiteUri: 'https://carfix.example/', nationalPhoneNumber: '050-765-4321' }),
  ]);
  await discover(app, places({ apiKey: 'gk', queries: ac, fetchImpl: g.f }), { source: 'google' });
  const reason = (key) => db.get('SELECT reason FROM seen WHERE domain = ?', key)?.reason;
  assert.match(reason('g:car'), /עסק לרכב \("רכב"\)/);
  assert.match(reason('g:garage'), /עסק לרכב/);
  assert.match(reason('g:handy'), /הנדימן או שיפוצים/, 'not an AC technician because the search was for one');
  assert.match(reason('carfix.example'), /עסק לרכב/);
  assert.match(reason('electric.unrelated.example'), /אין שם של עסק, רק "חשמלאי"/);
  // A plumber who also renovates, an AC technician who installs ("הרכבת"), and a locksmith who opens cars stay.
  for (const key of ['g:plumbs', 'g:fitter', 'g:keys']) assert.equal(db.get('SELECT qualified FROM leads WHERE domain = ?', key)?.qualified, 1, key);
});

test('the leads not written to yet are scored again under the new rules: the misfits are set aside, the rest stay', async () => {
  const { app, db } = testApp();
  const g = fakePlaces([place('car', { displayName: { text: 'אלכס חשמל רכב הרצליה' }, types: ['electrician'] }), place('ok', { nationalPhoneNumber: '052-111-2233' })]);
  await discover(app, places({ apiKey: 'gk', queries: Q, fetchImpl: g.f }), { source: 'google', force: true });
  // As this morning's search left them, before the rule: both fit, and one was written to already.
  db.run("UPDATE leads SET qualified = 1, reject = NULL, score = 70 WHERE domain = 'g:car'");
  db.run("INSERT INTO leads (domain, name, mobile, source, qualified, score, trade, created_at, updated_at, first_at, stage) VALUES ('g:sent', 'כולבו רכב אבי', '972521112299', 'google', 1, 60, 'electrician', '2026-11-23', '2026-11-23', '2026-11-23', 'waiting')");
  const r = await rescore(app);
  assert.equal(r.looked, 2, 'the one written to is not looked at');
  assert.deepEqual(r.changed.map((x) => [x.name, x.was.fit, x.now.fit]), [['אלכס חשמל רכב הרצליה', true, false]]);
  const car = db.get("SELECT qualified, reject FROM leads WHERE domain = 'g:car'");
  assert.equal(car.qualified, 0);
  assert.match(car.reject, /עסק לרכב/);
  assert.equal(db.get("SELECT qualified FROM leads WHERE domain = 'g:ok'").qualified, 1);
  assert.equal(db.get("SELECT qualified FROM leads WHERE domain = 'g:sent'").qualified, 1);
});

test('with only a Google key, the search runs on Google', async () => {
  const g = fakePlaces([place('b')]);
  const { app, db } = testApp({ env: { ...ENV, GOOGLE_MAPS_KEY: 'gk', BRAVE_API_KEY: '' } });
  app.apiFetch = g.f;
  assert.ok(startDiscovery(app, { trade: 'plumber', city: 'אשדוד', queries: 1 }));
  await app.discovery.done;
  assert.equal(g.asked.length, 1);
  assert.equal(db.get('SELECT source FROM runs ORDER BY id DESC').source, 'google');
  assert.equal(db.get("SELECT count(*) AS n FROM leads WHERE domain = 'g:b'").n, 1);
});

test('by hand, from a Facebook group: a name, a mobile and a trade make a lead that passes the bar', () => {
  const { db } = testApp();
  assert.equal(addByHand(db, { name: 'משה', mobile: '03-555-1234', trade: 'plumber' }).ok, false, 'a landline');
  assert.equal(addByHand(db, { name: 'משה', mobile: '050-111-2233', trade: 'baker' }).ok, false, 'not one of the four');
  const r = addByHand(db, { name: ' משה  החשמלאי ', mobile: '050-111-2233', trade: 'electrician', city: 'חולון', from: 'קבוצת "חולון שלנו"' });
  assert.ok(r.ok && !r.known);
  const x = db.get('SELECT * FROM leads WHERE id = ?', r.id);
  assert.deepEqual([x.name, x.mobile, x.trade, x.city, x.qualified, x.score, x.source, x.domain], ['משה החשמלאי', '972501112233', 'electrician', 'חולון', 1, 70, 'hand', null]);
  assert.equal(JSON.parse(x.detail).from, 'קבוצת "חולון שלנו"');
  // The same mobile again is that lead.
  assert.deepEqual(addByHand(db, { name: 'משה', mobile: '0501112233', trade: 'electrician' }), { ok: true, id: r.id, known: true, flash: 'המספר הזה כבר שייך לליד, הנה הוא.' });
  db.run("INSERT INTO stops (phone, why, at) VALUES ('972509998877', 'asked', '2026-11-22')");
  assert.equal(addByHand(db, { name: 'דני', mobile: '050-999-8877', trade: 'ac' }).ok, false, 'asked us to stop');
});
