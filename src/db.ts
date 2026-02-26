import Database from 'better-sqlite3';
import path from 'path';

const DB_PATH = path.join(__dirname, '..', 'pact.db');

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      avatar TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS pacts (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      icon TEXT NOT NULL,
      icon_family TEXT NOT NULL DEFAULT 'Ionicons',
      color TEXT NOT NULL DEFAULT '#4ECDC4',
      frequency TEXT NOT NULL DEFAULT 'daily',
      times_per_week INTEGER,
      deadline TEXT NOT NULL DEFAULT '23:59',
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pact_participants (
      pact_id TEXT NOT NULL REFERENCES pacts(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id),
      PRIMARY KEY (pact_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS submissions (
      id TEXT PRIMARY KEY,
      pact_id TEXT NOT NULL REFERENCES pacts(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id),
      photo_uri TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      verified INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      from_user_id TEXT REFERENCES users(id),
      pact_id TEXT NOT NULL REFERENCES pacts(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id),
      message TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      read INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_pact_participants_user ON pact_participants(user_id);
    CREATE INDEX IF NOT EXISTS idx_submissions_pact ON submissions(pact_id);
    CREATE INDEX IF NOT EXISTS idx_submissions_user ON submissions(user_id);
    CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
  `);

  // Migration: add status column to pact_participants if not present
  try {
    db.exec(`ALTER TABLE pact_participants ADD COLUMN status TEXT NOT NULL DEFAULT 'accepted'`);
  } catch (e: any) {
    if (!e.message.includes('duplicate column name')) throw e;
  }

  // Migration: add google_id column to users for Google OAuth
  try {
    db.exec(`ALTER TABLE users ADD COLUMN google_id TEXT`);
  } catch (e: any) {
    if (!e.message.includes('duplicate column name')) throw e;
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id) WHERE google_id IS NOT NULL`);
}

export default db;
