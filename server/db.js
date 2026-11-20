import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// One SQLite file holds everything: the leads, what was said to each, the numbers that asked us to stop, the sites
// already looked at, the discovery runs and the admin's sessions. node:sqlite is built into Node (22.13+), so there is
// nothing to install or compile on the server (openfrequency-accounts' src/db/index.js, made smaller).
//
// MIGRATIONS is append-only: the database remembers how many it ran (PRAGMA user_version), so a shipped one is never
// edited, only followed by a new one.

export const MIGRATIONS = [
  `
CREATE TABLE leads (
  id INTEGER PRIMARY KEY,
  domain TEXT UNIQUE,
  url TEXT,
  name TEXT NOT NULL,
  msg_name TEXT,
  trade TEXT,
  city TEXT,
  about TEXT,
  mobile TEXT,
  whatsapp_on_site INTEGER NOT NULL DEFAULT 0,
  phones TEXT NOT NULL DEFAULT '{}',
  score INTEGER NOT NULL DEFAULT 0,
  breakdown TEXT NOT NULL DEFAULT '[]',
  qualified INTEGER NOT NULL DEFAULT 0,
  reject TEXT,
  source TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  stage TEXT NOT NULL DEFAULT 'new' CHECK (stage IN ('new', 'waiting', 'talking', 'closed')),
  out_state TEXT NOT NULL DEFAULT 'not_sent',
  out_by TEXT,
  first_at TEXT,
  reminder_at TEXT,
  yes_at TEXT,
  replied_at TEXT,
  last_in_at TEXT,
  later_until TEXT,
  closed_why TEXT,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX leads_stage ON leads (stage, qualified, score DESC);
CREATE INDEX leads_mobile ON leads (mobile);

CREATE TABLE seen (
  domain TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  reason TEXT,
  at TEXT NOT NULL
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  lead_id INTEGER REFERENCES leads (id) ON DELETE CASCADE,
  phone TEXT NOT NULL,
  dir TEXT NOT NULL CHECK (dir IN ('in', 'out')),
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  wa_id TEXT UNIQUE,
  status TEXT,
  error TEXT,
  day TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX messages_lead ON messages (lead_id, at);
CREATE INDEX messages_day ON messages (day, dir, kind);

CREATE TABLE stops (
  phone TEXT PRIMARY KEY,
  why TEXT NOT NULL,
  at TEXT NOT NULL
);

CREATE TABLE runs (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  query TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  stats TEXT,
  error TEXT
);

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  seen_at TEXT NOT NULL,
  ip TEXT
);

CREATE TABLE kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`,
  // The service itself (docs/connecting.md): each customer has an assistant number on Telnyx that their unanswered
  // calls are forwarded to; it writes to each caller on WhatsApp, talks with them, and sends the summary to the
  // customer's own WhatsApp.
  `
CREATE TABLE customers (
  id INTEGER PRIMARY KEY,
  lead_id INTEGER,
  name TEXT NOT NULL,
  business TEXT NOT NULL,
  trade TEXT,
  phone TEXT NOT NULL,
  assistant TEXT UNIQUE,
  wa_status TEXT NOT NULL DEFAULT 'none' CHECK (wa_status IN ('none', 'verifying', 'connected')),
  otp_recording TEXT,
  otp_at TEXT,
  status TEXT NOT NULL DEFAULT 'setup' CHECK (status IN ('setup', 'active', 'paused', 'stopped')),
  stopped_at TEXT,
  last_call_at TEXT,
  owner_in_at TEXT,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE chats (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  caller TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'waiting' CHECK (state IN ('waiting', 'talking', 'done', 'stopped', 'failed')),
  calls INTEGER NOT NULL DEFAULT 1,
  what TEXT NOT NULL DEFAULT '',
  place TEXT NOT NULL DEFAULT '',
  urgency TEXT NOT NULL DEFAULT '',
  summary_at TEXT,
  note_at TEXT,
  last_in_at TEXT,
  last_out_at TEXT,
  opened_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX chats_caller ON chats (customer_id, caller, opened_at);

CREATE TABLE calls (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  chat_id INTEGER REFERENCES chats (id) ON DELETE SET NULL,
  caller TEXT,
  call_id TEXT UNIQUE,
  outcome TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX calls_customer ON calls (customer_id, at);

CREATE TABLE chat_messages (
  id INTEGER PRIMARY KEY,
  chat_id INTEGER REFERENCES chats (id) ON DELETE CASCADE,
  customer_id INTEGER NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  peer TEXT NOT NULL,
  dir TEXT NOT NULL CHECK (dir IN ('in', 'out')),
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  msg_id TEXT UNIQUE,
  status TEXT,
  error TEXT,
  at TEXT NOT NULL
);
CREATE INDEX chat_messages_chat ON chat_messages (chat_id, at);

CREATE TABLE skips (
  customer_id INTEGER NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  phone TEXT NOT NULL,
  why TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (customer_id, phone)
);
`,
  // Paying (docs/payments.md): each customer pays ahead for each month by bank transfer, sends the transfer's picture
  // to the business number, and the admin checks the bank and records it; Morning issues the invoice-receipt.
  `
ALTER TABLE customers ADD COLUMN price REAL NOT NULL DEFAULT 149;
ALTER TABLE customers ADD COLUMN free INTEGER NOT NULL DEFAULT 0;
ALTER TABLE customers ADD COLUMN paid_until TEXT;
ALTER TABLE customers ADD COLUMN ends_on TEXT;
ALTER TABLE customers ADD COLUMN invoice_name TEXT;
ALTER TABLE customers ADD COLUMN tax_id TEXT;
ALTER TABLE customers ADD COLUMN address TEXT;
ALTER TABLE customers ADD COLUMN email TEXT;

CREATE TABLE receipts (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER REFERENCES customers (id) ON DELETE SET NULL,
  business TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('whatsapp', 'manual')),
  phone TEXT NOT NULL DEFAULT '',
  msg_id TEXT UNIQUE,
  type TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT,
  file BLOB,
  owed_json TEXT,
  decision TEXT CHECK (decision IN ('paid', 'not_paid')),
  decided_at TEXT,
  bill_json TEXT,
  morning_state TEXT,
  morning_at TEXT,
  morning_error_json TEXT,
  morning_doc_id TEXT UNIQUE,
  morning_number TEXT,
  morning_url TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX receipts_customer ON receipts (customer_id, created_at);
CREATE INDEX receipts_waiting ON receipts (decided_at, created_at);

CREATE TABLE pay_notices (
  customer_id INTEGER NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  until TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (customer_id, until, kind)
);
`,
];

export class Db {
  constructor(file = ':memory:') {
    if (file !== ':memory:') mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    this.raw = new DatabaseSync(file);
    this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    const have = this.raw.prepare('PRAGMA user_version').get().user_version;
    if (have > MIGRATIONS.length) throw new Error(`the database is at migration ${have} and this build knows ${MIGRATIONS.length}: deploy the newer build`);
    for (let v = have; v < MIGRATIONS.length; v++) {
      this.tx(() => {
        this.raw.exec(MIGRATIONS[v]);
        this.raw.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  }

  run(sql, ...params) {
    return this.raw.prepare(sql).run(...params);
  }

  get(sql, ...params) {
    return this.raw.prepare(sql).get(...params);
  }

  all(sql, ...params) {
    return this.raw.prepare(sql).all(...params);
  }

  tx(fn) {
    this.raw.exec('BEGIN');
    try {
      const out = fn();
      this.raw.exec('COMMIT');
      return out;
    } catch (e) {
      this.raw.exec('ROLLBACK');
      throw e;
    }
  }

  kv(key, value) {
    if (value === undefined) return this.get('SELECT value FROM kv WHERE key = ?', key)?.value ?? null;
    this.run('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, String(value));
    return value;
  }

  close() {
    this.raw.close();
  }
}
