/**
 * Reusable test helpers for Pact backend tests.
 *
 * Each test file calls setupTestApp() to get an isolated Express app + SQLite DB.
 * vitest runs each file in isolation, so env vars set in beforeAll take effect.
 */
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';
import jwt from 'jsonwebtoken';
import path from 'path';
import fs from 'fs';
import { beforeAll, afterAll, vi } from 'vitest';

const PASSWORD_HASH = bcrypt.hashSync('password123', 4);
const TEST_JWT_SECRET = 'test-secret-key';

export interface TestUser {
  id: string;
  name: string;
  username: string;
  email: string;
  token: string;
}

export interface TestPact {
  id: string;
  title: string;
}

export interface TestContext {
  app: Express;
  db: Database.Database;
}

/**
 * Sets up an isolated test app with its own SQLite database.
 * Call once per test file at the top level.
 */
export function setupTestApp(): TestContext {
  const testId = uuid().slice(0, 8);
  const dbDir = path.join(__dirname, '..', '.test-data', testId);

  let db: Database.Database;
  let app: Express;

  const ctx = {} as TestContext;

  beforeAll(async () => {
    fs.mkdirSync(path.join(dbDir, 'uploads'), { recursive: true });

    process.env.DATA_DIR = dbDir;
    process.env.JWT_SECRET = TEST_JWT_SECRET;

    // Reset module cache so db.ts picks up the new DATA_DIR
    vi.resetModules();

    const dbModule = await import('../src/db');
    dbModule.initDb();
    db = dbModule.default;
    Object.defineProperty(ctx, 'db', { get: () => db, configurable: true });

    const appModule = await import('../src/app');
    app = appModule.createApp();
    Object.defineProperty(ctx, 'app', { get: () => app, configurable: true });
  });

  afterAll(() => {
    try { if (db) db.close(); } catch { /* ignore */ }
    try { fs.rmSync(dbDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  return ctx;
}

/** Create a test user and return user data + JWT token */
export function createTestUser(db: Database.Database, overrides: Partial<{ name: string; username: string; email: string }> = {}): TestUser {
  const id = uuid();
  const name = overrides.name || `User ${id.slice(0, 4)}`;
  const username = overrides.username || `user_${id.slice(0, 8)}`;
  const email = overrides.email || `${username}@test.app`;

  db.prepare(
    'INSERT INTO users (id, name, username, email, password_hash, avatar) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, name, username, email, PASSWORD_HASH, '');

  const token = jwt.sign({ userId: id }, TEST_JWT_SECRET, { expiresIn: '1h' });
  return { id, name, username, email, token };
}

/** Create a test pact with the given user as creator+participant */
export function createTestPact(
  db: Database.Database,
  creatorId: string,
  overrides: Partial<{ title: string; frequency: string; timezone: string }> = {}
): TestPact {
  const id = uuid();
  const title = overrides.title || `Pact ${id.slice(0, 4)}`;
  const now = new Date().toISOString().split('T')[0];

  db.prepare(`
    INSERT INTO pacts (id, title, icon, icon_family, color, frequency, timezone, deadline, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, title, 'fitness', 'Ionicons', '#4ECDC4', overrides.frequency || 'daily', overrides.timezone || 'UTC', '23:59', creatorId, now);

  db.prepare('INSERT INTO pact_participants (pact_id, user_id, status) VALUES (?, ?, ?)').run(id, creatorId, 'accepted');
  return { id, title };
}

/** Add a user as accepted participant of a pact */
export function addParticipant(db: Database.Database, pactId: string, userId: string) {
  db.prepare('INSERT OR IGNORE INTO pact_participants (pact_id, user_id, status) VALUES (?, ?, ?)').run(pactId, userId, 'accepted');
}

/** Create a submission for a user in a pact */
export function createSubmission(db: Database.Database, pactId: string, userId: string, timestamp?: string): string {
  const id = uuid();
  const ts = timestamp || new Date().toISOString();
  db.prepare(
    'INSERT INTO submissions (id, pact_id, user_id, photo_uri, timestamp, verified) VALUES (?, ?, ?, ?, ?, 1)'
  ).run(id, pactId, userId, '/uploads/test.jpg', ts);
  return id;
}

/** Create a notification for a user */
export function createNotification(
  db: Database.Database,
  userId: string,
  overrides: Partial<{ type: string; fromUserId: string; pactId: string; message: string; timestamp: string; read: boolean }> = {}
): string {
  const id = uuid();
  db.prepare(
    'INSERT INTO notifications (id, type, from_user_id, pact_id, user_id, message, timestamp, read) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    id,
    overrides.type || 'nudge',
    overrides.fromUserId || null,
    overrides.pactId || null,
    userId,
    overrides.message || `Test notification ${id.slice(0, 4)}`,
    overrides.timestamp || new Date().toISOString(),
    overrides.read ? 1 : 0
  );
  return id;
}

/** Create a friendship between two users */
export function createFriendship(db: Database.Database, userId1: string, userId2: string) {
  const id = uuid();
  db.prepare(
    'INSERT INTO friendships (id, requester_id, addressee_id, status, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, userId1, userId2, 'accepted', new Date().toISOString());
  return id;
}

/** Authorization header for a test user */
export function authHeader(user: TestUser): { Authorization: string } {
  return { Authorization: `Bearer ${user.token}` };
}

/**
 * Generate N timestamps spaced 1 second apart.
 * Returns them in DESC order (newest first — index 0 is newest).
 */
export function generateTimestamps(count: number, startDate?: Date): string[] {
  const start = startDate || new Date('2025-06-01T12:00:00.000Z');
  const timestamps: string[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(start.getTime() + i * 1000);
    timestamps.push(d.toISOString());
  }
  return timestamps.reverse();
}
