import Database from 'better-sqlite3';
import path from 'path';

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..');
const DB_PATH = path.join(DATA_DIR, 'pact.db');

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

  // Migration: add timezone column to pacts (defaults to UTC for existing pacts)
  try {
    db.exec(`ALTER TABLE pacts ADD COLUMN timezone TEXT NOT NULL DEFAULT 'UTC'`);
  } catch (e: any) {
    if (!e.message.includes('duplicate column name')) throw e;
  }

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

  // Friendships table
  db.exec(`
    CREATE TABLE IF NOT EXISTS friendships (
      id TEXT PRIMARY KEY,
      requester_id TEXT NOT NULL REFERENCES users(id),
      addressee_id TEXT NOT NULL REFERENCES users(id),
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      UNIQUE(requester_id, addressee_id)
    );
    CREATE INDEX IF NOT EXISTS idx_friendships_requester ON friendships(requester_id);
    CREATE INDEX IF NOT EXISTS idx_friendships_addressee ON friendships(addressee_id);
  `);

  // Reactions table (emoji reactions on submissions)
  db.exec(`
    CREATE TABLE IF NOT EXISTS reactions (
      id TEXT PRIMARY KEY,
      submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id),
      emoji TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(submission_id, user_id, emoji)
    );
    CREATE INDEX IF NOT EXISTS idx_reactions_submission ON reactions(submission_id);
  `);

  // Messages table (group chat per pact)
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      pact_id TEXT NOT NULL REFERENCES pacts(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id),
      text TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_pact_created ON messages(pact_id, created_at);
  `);

  // Push subscriptions table (for web push notifications)
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id);
  `);

  // Streak freezes table
  db.exec(`
    CREATE TABLE IF NOT EXISTS streak_freezes (
      id TEXT PRIMARY KEY,
      pact_id TEXT NOT NULL REFERENCES pacts(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id),
      used_for_date TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(pact_id, user_id, used_for_date)
    );
    CREATE INDEX IF NOT EXISTS idx_streak_freezes_pact_user ON streak_freezes(pact_id, user_id);
  `);

  // Compound indexes for cursor-based pagination
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_notifications_user_timestamp ON notifications(user_id, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_submissions_pact_timestamp ON submissions(pact_id, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_submissions_timestamp ON submissions(timestamp DESC);
  `);

  // Migration: make pact_id nullable in notifications (needed for friend request notifications)
  const colInfo = db.prepare("PRAGMA table_info(notifications)").all() as any[];
  const pactIdCol = colInfo.find((c: any) => c.name === 'pact_id');
  if (pactIdCol && pactIdCol.notnull === 1) {
    db.pragma('foreign_keys = OFF');
    db.exec(`
      CREATE TABLE notifications_new (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        from_user_id TEXT REFERENCES users(id),
        pact_id TEXT REFERENCES pacts(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id),
        message TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        read INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO notifications_new SELECT * FROM notifications;
      DROP TABLE notifications;
      ALTER TABLE notifications_new RENAME TO notifications;
      CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
    `);
    db.pragma('foreign_keys = ON');
  }
}

export default db;
