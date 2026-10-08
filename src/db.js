/**
 * db.js — SQLite database setup (better-sqlite3).
 *
 * All queries in this codebase use parameterized statements (? placeholders),
 * so user input can never break out of a query (SQL-injection safe).
 *
 * DB location: ./data/panel.db (override with DB_PATH env var).
 * NOTE: on Render's free tier there is no persistent disk, so the SQLite file
 * is ephemeral — it survives while the service runs but is wiped on redeploy
 * or restart. For production use a paid disk or an external database.
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'panel.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT UNIQUE NOT NULL,
  email         TEXT,
  password_hash TEXT NOT NULL,
  balance       REAL NOT NULL DEFAULT 0,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS services (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  name                TEXT NOT NULL,
  platform            TEXT DEFAULT '',
  type                TEXT DEFAULT '',
  rate                REAL NOT NULL,              -- price per 1000 units (USD)
  min_qty             INTEGER NOT NULL DEFAULT 100,
  max_qty             INTEGER NOT NULL DEFAULT 100000,
  provider_service_id TEXT,                        -- linked wholesale service id (optional)
  active              INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Single-row table (id always 1) holding the wholesale provider credentials.
CREATE TABLE IF NOT EXISTS provider_settings (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  api_url    TEXT,
  api_key    TEXT,
  updated_at TEXT
);

-- Last synced wholesale catalog (from provider action=services).
CREATE TABLE IF NOT EXISTS provider_services (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_service_id TEXT NOT NULL UNIQUE,
  name                TEXT,
  type                TEXT,
  category            TEXT,
  rate                REAL,
  min_qty             INTEGER,
  max_qty             INTEGER,
  status              TEXT,
  synced_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS orders (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           INTEGER NOT NULL REFERENCES users(id),
  service_id        INTEGER NOT NULL REFERENCES services(id),
  link              TEXT NOT NULL,
  quantity          INTEGER NOT NULL,
  charge            REAL NOT NULL,                -- amount deducted from user balance
  status            TEXT NOT NULL DEFAULT 'pending',
  provider_order_id TEXT,                          -- wholesale order id after forwarding
  provider_status   TEXT,
  last_error        TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

CREATE TABLE IF NOT EXISTS transactions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  type          TEXT NOT NULL,     -- deposit | order | refund | adjustment
  amount        REAL NOT NULL,     -- positive = credit, negative = debit
  balance_after REAL NOT NULL,
  note          TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions(user_id);

CREATE TABLE IF NOT EXISTS fund_requests (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  amount     REAL NOT NULL,
  method     TEXT,
  note       TEXT,
  status     TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | rejected
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at TEXT
);

CREATE TABLE IF NOT EXISTS tickets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  subject    TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'open',     -- open | answered | closed
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ticket_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id  INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  message    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

/**
 * Seed the owner/admin account.
 * Priority: ADMIN_USERNAME + ADMIN_PASSWORD env vars. Fallback: the first
 * user to sign up becomes admin automatically (only when no admin exists).
 * Returns the admin user row or null.
 */
function ensureAdminFromEnv() {
  const username = (process.env.ADMIN_USERNAME || '').trim();
  const password = process.env.ADMIN_PASSWORD || '';
  if (!username || !password) return null;
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    // Make sure the seeded user stays admin.
    db.prepare('UPDATE users SET is_admin = 1 WHERE username = ?').run(username);
    return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  }
  const bcrypt = require('bcryptjs');
  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare(
    'INSERT INTO users (username, password_hash, balance, is_admin) VALUES (?, ?, 0, 1)'
  ).run(username, hash);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
}

/** Seed a few demo services on a brand-new database. */
function seedDemoServices() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM services').get().c;
  if (count > 0) return;
  const insert = db.prepare(
    'INSERT INTO services (name, platform, type, rate, min_qty, max_qty, provider_service_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  insert.run('Instagram Followers | Real', 'Instagram', 'Followers', 2.5, 100, 100000, null);
  insert.run('Instagram Likes | Instant', 'Instagram', 'Likes', 0.5, 50, 50000, null);
  insert.run('TikTok Followers', 'TikTok', 'Followers', 3.0, 100, 200000, null);
  insert.run('YouTube Views | Fast', 'YouTube', 'Views', 1.2, 500, 1000000, null);
}

module.exports = { db, ensureAdminFromEnv, seedDemoServices };
