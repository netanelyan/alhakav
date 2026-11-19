import { dayNumber, israelDate, israelParts, now, nowIso } from './clock.js';
import { detect, siteKey } from './detect.js';
import { num } from './env.js';
import { scoreLead } from './score.js';
import { brave, queriesFor } from './sources.js';

// One discovery run: candidate sites in, leads out (openfrequency-toran's src/leads/discover.ts).
//
// For each candidate: its site -> already looked at? skip (a site is looked at once; what it was is kept in `seen`) ->
// read it -> score it. A site of one of the four trades with a mobile is saved as a lead, qualified or under the bar,
// with its reasons; anything else is remembered as rejected and never read again. A mobile that asked us to stop is
// never added, and a mobile that another lead already has is that lead (one tradesperson, two sites).
//
// A site the admin adds by its address is read again even when it was looked at, and saved as a lead whatever it
// scores, so it can be looked at and written to by hand.

const markSeen = (db, domain, status, reason = null) =>
  db.run('INSERT INTO seen (domain, status, reason, at) VALUES (?, ?, ?, ?) ON CONFLICT (domain) DO UPDATE SET status = excluded.status, reason = excluded.reason, at = excluded.at', domain, status, reason, nowIso());

const known = (db, domain) => Boolean(db.get('SELECT 1 FROM seen WHERE domain = ?', domain) || db.get('SELECT 1 FROM leads WHERE domain = ?', domain));

/** Save a site as a lead, or update the one it already is. A lead already written to keeps the number it was written on. */
export function saveLead(db, d, s, c) {
  const at = nowIso();
  const fields = {
    url: d.url,
    name: d.name || d.domain,
    trade: d.trade,
    city: d.city,
    about: d.about || null,
    whatsapp_on_site: d.whatsappLinked || d.waWidget ? 1 : 0,
    phones: JSON.stringify({ mobiles: d.mobiles, others: d.others, specials: d.specials }),
    score: s.score,
    breakdown: JSON.stringify(s.breakdown),
    qualified: s.qualified ? 1 : 0,
    reject: s.reject,
  };
  const row = db.get('SELECT id, stage FROM leads WHERE domain = ?', d.domain);
  if (row) {
    const keys = Object.keys(fields);
    db.run(`UPDATE leads SET ${keys.map((k) => `${k} = ?`).join(', ')}${row.stage === 'new' ? ', mobile = ?' : ''}, updated_at = ? WHERE id = ?`, ...keys.map((k) => fields[k]), ...(row.stage === 'new' ? [d.mobile] : []), at, row.id);
    return { id: row.id, created: false };
  }
  const r = db.run(
    `INSERT INTO leads (domain, mobile, source, detail, created_at, updated_at, ${Object.keys(fields).join(', ')}) VALUES (?, ?, ?, ?, ?, ?, ${Object.keys(fields).map(() => '?').join(', ')})`,
    d.domain,
    d.mobile,
    c.source,
    JSON.stringify(c.detail || {}),
    at,
    at,
    ...Object.values(fields)
  );
  return { id: Number(r.lastInsertRowid), created: true };
}

export async function discover(app, candidates, { limit = 30, concurrency = 3, source = 'mixed', query = null, force = false } = {}) {
  const { db } = app;
  const run = Number(db.run('INSERT INTO runs (source, query, started_at) VALUES (?, ?, ?)', source, query, nowIso()).lastInsertRowid);
  const stats = { looked: 0, skipped: 0, added: 0, updated: 0, fit: 0, rejected: 0, failed: 0 };
  const results = [];
  const inFlight = new Set();
  const workers = new Set();

  async function one(c, key) {
    stats.looked++;
    let d;
    try {
      d = await detect(c.url, { fetcher: app.fetchSite });
    } catch (e) {
      stats.failed++;
      markSeen(db, key, 'failed', String(e.code || e.message).slice(0, 200));
      results.push({ key, error: e.message });
      return;
    }
    const site = d.domain || key;
    // A redirect can land on a site we already have (a second domain of the same business).
    if (site !== key && !force && known(db, site)) {
      stats.skipped++;
      markSeen(db, key, 'merged', `מפנה אל ${site}`);
      return;
    }
    d.domain = site;
    const s = scoreLead(d, now());
    if (s.reject && !force) {
      stats.rejected++;
      markSeen(db, key, 'rejected', s.reject);
      results.push({ key, reject: s.reject });
      return;
    }
    if (d.mobile && db.get('SELECT 1 FROM stops WHERE phone = ?', d.mobile)) {
      stats.rejected++;
      markSeen(db, key, 'stopped', 'המספר ביקש שלא נכתוב אליו');
      results.push({ key, reject: 'stopped' });
      return;
    }
    const same = d.mobile && db.get('SELECT id FROM leads WHERE mobile = ? AND domain IS NOT ?', d.mobile, site);
    if (same && !force) {
      stats.skipped++;
      markSeen(db, key, 'merged', `אותו נייד כמו ליד ${same.id}`);
      return;
    }
    const saved = saveLead(db, d, s, c);
    if (saved.created) stats.added++;
    else stats.updated++;
    if (s.qualified) stats.fit++;
    markSeen(db, site, 'lead');
    if (key !== site) markSeen(db, key, 'merged', `מפנה אל ${site}`);
    results.push({ key: site, id: saved.id, name: d.name, score: s.score, qualified: s.qualified, reject: s.reject });
    app.log(`  ${s.qualified ? '✓' : '–'} ${site} ${d.trade || '-'} ${s.score}${s.reject ? ` (${s.reject})` : ''}`);
  }

  let error = null;
  try {
    for await (const c of candidates) {
      if (stats.added + stats.updated >= limit) break;
      const key = siteKey(c.url);
      if (!key || inFlight.has(key) || (!force && known(db, key))) {
        stats.skipped++;
        continue;
      }
      inFlight.add(key);
      const w = one(c, key).finally(() => workers.delete(w));
      workers.add(w);
      if (workers.size >= concurrency) await Promise.race(workers);
    }
  } catch (e) {
    error = e.message;
  }
  await Promise.all(workers);
  db.run('UPDATE runs SET finished_at = ?, stats = ?, error = ? WHERE id = ?', nowIso(), JSON.stringify(stats), error, run);
  if (error) throw Object.assign(new Error(error), { stats });
  return { stats, results };
}

/** The last run, for the leads page: when, what it looked at, what it added, and why it stopped. */
export function lastRun(db) {
  const r = db.get('SELECT * FROM runs WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1');
  return r ? { ...r, stats: JSON.parse(r.stats || '{}') } : null;
}

/** Brave's searches in the background, one run at a time. false when one is running or Brave is not set up. */
export function startDiscovery(app, { trade = '', city = '', queries, limit } = {}) {
  const key = String(app.env.BRAVE_API_KEY || '').trim();
  if (app.discovery.running || !key) return false;
  const qs = queriesFor(dayNumber(), queries ?? num(app.env.DISCOVER_QUERIES, 3) ?? 3, { trade, city });
  app.discovery.running = { at: now(), trade, city };
  app.discovery.done = (async () => {
    try {
      const r = await discover(app, brave({ apiKey: key, queries: qs, fetchImpl: app.apiFetch, pause: app.searchPause ?? 1100 }), {
        limit: limit ?? num(app.env.DISCOVER_LIMIT, 30),
        source: 'brave',
        query: qs.map((q) => q.q).join(' · '),
      });
      app.log(`[discover] ${qs.map((q) => q.q).join(' · ')}: ${JSON.stringify(r.stats)}`);
    } catch (e) {
      app.log(`[discover] stopped: ${e.message}`);
    } finally {
      app.discovery.running = null;
    }
  })();
  return true;
}

/** The day's searches, once a day after 07:00 Israel time, while DISCOVER_QUERIES is above 0 and Brave is set up. */
export function dailyDiscovery(app, at = now()) {
  const n = num(app.env.DISCOVER_QUERIES, 3);
  if (n <= 0 || !String(app.env.BRAVE_API_KEY || '').trim() || israelParts(at).hour < 7) return false;
  const today = israelDate(at);
  if (app.db.kv('daily_discovery') === today) return false;
  if (!startDiscovery(app, { queries: n })) return false;
  app.db.kv('daily_discovery', today);
  return true;
}
