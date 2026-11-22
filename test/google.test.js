import assert from 'node:assert/strict';
import { test } from 'node:test';
import { discover, startDiscovery } from '../server/discover.js';
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
