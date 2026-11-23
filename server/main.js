#!/usr/bin/env node
import { createServer } from 'node:http';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { MIN_PASSWORD, hashPassword } from './auth.js';
import { DAY, MINUTE, dayNumber, now, nowIso } from './clock.js';
import { Db } from './db.js';
import { dailyDiscovery, discover, searchKeys } from './discover.js';
import { digestTick } from './digest.js';
import { loadEnv, num } from './env.js';
import { purgeLeads } from './leads.js';
import { purgeOld } from './retention.js';
import { payTick } from './pay.js';
import { numbersTick } from './numbers.js';
import { serviceTick } from './service.js';
import { handler, makeApp } from './app.js';
import { brave, fromUrls, places, queriesFor, seeds, together } from './sources.js';

//   node server/main.js serve                     the admin server (npm start)
//   node server/main.js password                  a hash for ADMIN_PASSWORD_HASH (npm run admin:password)
//   node server/main.js discover [--trade plumber|electrician|ac|locksmith] [--city אשדוד] [--limit 30]
//                                [--url site.co.il] [--seeds]
//                                                 one discovery run now, from Brave, one site, or private/seeds.txt
//   node server/main.js list [n]                  the newest n leads (default 20)
//   node server/main.js support [file]            what Toran knows about על הקו, for its company sync (docs/toran.md)
//   node server/main.js templates [file]          the WhatsApp templates to submit to Meta (server/templates.js)
//   node server/main.js eval                      המוקדן's guardrails against the real model (server/eval.js)
//
// Settings: the environment, then private/.env (ENV_FILE moves it). .env.example lists them.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = loadEnv(process.env.ENV_FILE || path.join(ROOT, 'private', '.env'));
const [cmd = 'serve', ...rest] = process.argv.slice(2);
const flag = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i < 0 ? undefined : rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[i + 1] : true;
};
const log = (m) => console.log(`${new Date().toISOString()} ${m}`);
const openDb = () => new Db(path.resolve(ROOT, env.DB_FILE || 'private/leads.db'));

async function serve() {
  const db = openDb();
  const app = makeApp({ db, env, log });
  const server = createServer(handler(app));
  const port = num(env.PORT, 4760);
  const host = env.HOST || '127.0.0.1';
  server.listen(port, host, () => log(`[serve] listening on http://${host}:${port}/admin`));
  const tick = () => {
    try {
      if (dailyDiscovery(app)) log('[serve] the daily search started');
      db.run('DELETE FROM sessions WHERE seen_at < ?', nowIso(now() - 14 * DAY));
      const gone = purgeLeads(db, num(env.LEAD_KEEP_MONTHS, 6));
      if (gone) log(`[serve] ${gone} leads past LEAD_KEEP_MONTHS deleted`);
      const old = purgeOld(db);
      if (Object.values(old).some(Boolean)) log(`[serve] past their time and deleted: ${JSON.stringify(old)}`);
    } catch (e) {
      log(`[serve] the daily tick failed: ${e.message}`);
    }
  };
  // The service's notes and summaries that wait for time, the payment reminders and the owner's evening summary, once a
  // minute.
  setInterval(() => {
    serviceTick(app).catch((e) => log(`[service] tick failed: ${e.message}`));
    payTick(app).catch((e) => log(`[pay] tick failed: ${e.message}`));
    numbersTick(app).catch((e) => log(`[numbers] tick failed: ${e.message}`));
    digestTick(app).catch((e) => log(`[digest] tick failed: ${e.message}`));
  }, MINUTE).unref();
  setTimeout(tick, MINUTE).unref();
  setInterval(tick, 30 * MINUTE).unref();
  const stop = () => {
    log('[serve] stopping');
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

async function readPassword() {
  if (!process.stdin.isTTY) {
    let s = '';
    for await (const chunk of process.stdin) s += chunk;
    return s.replace(/\r?\n$/, '');
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  process.stdout.write(`Password (${MIN_PASSWORD} characters or more): `);
  rl._writeToOutput = () => {}; // nothing typed is echoed
  const pw = await new Promise((resolve) => rl.question('', resolve));
  rl.close();
  process.stdout.write('\n');
  return pw;
}

async function password() {
  const pw = await readPassword();
  if (pw.length < MIN_PASSWORD) {
    console.error(`The password needs ${MIN_PASSWORD} characters or more.`);
    process.exit(1);
  }
  console.log(`\nPut this line in private/.env:\n\nADMIN_PASSWORD_HASH=${hashPassword(pw)}\n`);
  if (String(env.SESSION_SECRET || '').length < 32) console.log(`and this one too, once:\n\nSESSION_SECRET=${(await import('node:crypto')).randomBytes(32).toString('hex')}\n`);
}

async function discoverNow() {
  const db = openDb();
  const app = makeApp({ db, env, log });
  const limit = Number(flag('limit')) || num(env.DISCOVER_LIMIT, 30);
  let candidates;
  let source;
  if (typeof flag('url') === 'string') [candidates, source] = [fromUrls([flag('url')]), 'admin'];
  else if (flag('seeds')) [candidates, source] = [seeds(path.join(ROOT, 'private', 'seeds.txt')), 'seed'];
  else {
    const k = searchKeys(env);
    if (!k.google && !k.brave) {
      console.error('Neither GOOGLE_MAPS_KEY nor BRAVE_API_KEY is set: use --url <site> or --seeds');
      process.exit(1);
    }
    const qs = queriesFor(dayNumber(), num(env.DISCOVER_QUERIES, 3) || 3, { trade: flag('trade') || '', city: flag('city') || '' });
    log(`[discover] ${qs.map((q) => q.q).join(' · ')}`);
    candidates = together(...[k.google && places({ apiKey: k.google, queries: qs }), k.brave && brave({ apiKey: k.brave, queries: qs })].filter(Boolean));
    source = k.google && k.brave ? 'mixed' : k.google ? 'google' : 'brave';
  }
  const r = await discover(app, candidates, { limit, source, force: source === 'admin' });
  log(`[discover] ${JSON.stringify(r.stats)}`);
  db.close();
}

function list() {
  const db = openDb();
  const n = Number(rest[0]) || 20;
  for (const x of db.all('SELECT id, name, domain, trade, city, score, qualified, stage, out_state FROM leads ORDER BY id DESC LIMIT ?', n)) {
    console.log([x.id, x.stage, x.out_state, x.qualified ? `✓${x.score}` : `–${x.score}`, x.trade || '-', x.city || '-', x.name, x.domain || ''].join('\t'));
  }
  db.close();
}

/** המוקדן's guardrails against the real model (server/eval.js): each case graded in code. Exits 1 when one fails. */
async function evalNow() {
  const { makeClaude } = await import('./claude.js');
  const { runEval } = await import('./eval.js');
  const claude = makeClaude(env);
  if (!claude) {
    console.error('ANTHROPIC_API_KEY is not set');
    process.exit(1);
  }
  const results = await runEval(claude);
  for (const r of results) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}`);
    if (r.error) console.log(`      error: ${r.error}`);
    else {
      console.log(`      reply: ${r.reply}`);
      if (r.cut.length) console.log(`      the guard cut ${r.cut.join(', ')} from: ${r.raw}`);
      console.log(`      what: ${r.what} | place: ${r.place} | urgency: ${r.urgency}`);
    }
  }
  const failed = results.filter((r) => !r.pass).length;
  console.log(`
${results.length - failed} of ${results.length} passed (${claude.model})`);
  if (failed) process.exitCode = 1;
}

/** What Toran knows about על הקו, as a file for openfrequency-toran's company sync (server/support.js). */
async function support() {
  const { supportExport } = await import('./support.js');
  const json = `${JSON.stringify(supportExport(env), null, 2)}\n`;
  if (rest[0]) {
    (await import('node:fs')).writeFileSync(rest[0], json);
    console.log(`wrote ${rest[0]}`);
  } else process.stdout.write(json);
}

/** The WhatsApp templates in the look of every message, as Meta's API takes them (server/templates.js). */
async function templates() {
  const { templateDefs } = await import('./templates.js');
  const json = `${JSON.stringify(templateDefs(env), null, 2)}\n`;
  if (rest[0]) {
    (await import('node:fs')).writeFileSync(rest[0], json);
    console.log(`wrote ${rest[0]}`);
  } else process.stdout.write(json);
}

const run = { serve, password, discover: discoverNow, list, support, templates, eval: evalNow }[cmd];
if (!run) {
  console.error(`unknown command: ${cmd} (serve, password, discover, list, support, templates, eval)`);
  process.exit(1);
}
await run();
