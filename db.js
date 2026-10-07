// db.js — tiny dual-driver database layer.
// Uses PostgreSQL when DATABASE_URL is set (Railway), otherwise falls back
// to a local SQLite file via Node's built-in node:sqlite (no native deps).
// Schema is created automatically on boot.

const path = require("path");
const fs = require("fs");

const usePg = !!process.env.DATABASE_URL;

let pgPool = null;
let sqlite = null;

async function init() {
  if (usePg) {
    const { Pool } = require("pg");
    pgPool = new Pool({ connectionString: process.env.DATABASE_URL });
  } else {
    const { DatabaseSync } = require("node:sqlite");
    const dir = path.join(__dirname, "data");
    fs.mkdirSync(dir, { recursive: true });
    sqlite = new DatabaseSync(path.join(dir, "goonbucks.db"));
    sqlite.exec("PRAGMA journal_mode = WAL;");
  }

  const idCol = usePg ? "SERIAL PRIMARY KEY" : "INTEGER PRIMARY KEY AUTOINCREMENT";

  await exec(`
    CREATE TABLE IF NOT EXISTS users (
      id ${idCol},
      team_name TEXT UNIQUE NOT NULL,
      token TEXT NOT NULL,
      bankroll NUMERIC NOT NULL DEFAULT 1000,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS weeks (
      id ${idCol},
      week_number INTEGER UNIQUE NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      tiebreaker_actual NUMERIC,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS matchups (
      id ${idCol},
      week_id INTEGER NOT NULL REFERENCES weeks(id),
      idx INTEGER NOT NULL,
      team_a TEXT NOT NULL,
      team_b TEXT NOT NULL,
      odds_a INTEGER NOT NULL,
      odds_b INTEGER NOT NULL,
      winner TEXT,
      UNIQUE (week_id, idx)
    );
    CREATE TABLE IF NOT EXISTS bets (
      id ${idCol},
      user_id INTEGER NOT NULL REFERENCES users(id),
      week_id INTEGER NOT NULL REFERENCES weeks(id),
      matchup_id INTEGER NOT NULL REFERENCES matchups(id),
      side TEXT NOT NULL,
      odds INTEGER NOT NULL,
      stake NUMERIC NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      payout NUMERIC,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS props (
      id ${idCol},
      week_id INTEGER NOT NULL REFERENCES weeks(id),
      idx INTEGER NOT NULL,
      label TEXT NOT NULL,
      option_a TEXT NOT NULL,
      option_b TEXT NOT NULL,
      odds_a INTEGER NOT NULL,
      odds_b INTEGER NOT NULL,
      winner TEXT,
      UNIQUE (week_id, idx)
    );
    CREATE TABLE IF NOT EXISTS prop_bets (
      id ${idCol},
      user_id INTEGER NOT NULL REFERENCES users(id),
      week_id INTEGER NOT NULL REFERENCES weeks(id),
      prop_id INTEGER NOT NULL REFERENCES props(id),
      side TEXT NOT NULL,
      odds INTEGER NOT NULL,
      stake NUMERIC NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      payout NUMERIC,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS pickems (
      id ${idCol},
      user_id INTEGER NOT NULL REFERENCES users(id),
      week_id INTEGER NOT NULL REFERENCES weeks(id),
      picks TEXT NOT NULL,
      tiebreaker NUMERIC NOT NULL,
      correct INTEGER,
      tiebreak_diff NUMERIC,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (user_id, week_id)
    );
  `);
}

// Run a statement that returns no rows.
async function exec(sql) {
  if (usePg) {
    await pgPool.query(sql);
  } else {
    sqlite.exec(sql);
  }
}

// Query returning { rows: [...] }. Write SQL with $1-style params.
async function query(sql, params = []) {
  if (usePg) {
    const res = await pgPool.query(sql, params);
    return { rows: res.rows };
  }
  const sqliteSql = sql.replace(/\$\d+/g, "?");
  if (/^\s*select/i.test(sql)) {
    return { rows: sqlite.prepare(sqliteSql).all(...params) };
  }
  const info = sqlite.prepare(sqliteSql).run(...params);
  return { rows: [], lastInsertRowid: Number(info.lastInsertRowid) };
}

// Insert a row and get the new id back on both drivers.
async function insertReturningId(table, cols, vals) {
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
  if (usePg) {
    const res = await pgPool.query(
      `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${placeholders}) RETURNING id`,
      vals
    );
    return res.rows[0].id;
  }
  const info = sqlite
    .prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${placeholders.replace(/\$\d+/g, "?")})`)
    .run(...vals);
  return Number(info.lastInsertRowid);
}

module.exports = { init, query, insertReturningId, usePg };
