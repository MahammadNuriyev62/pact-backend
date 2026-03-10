import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import {
  setupTestApp,
  createTestUser,
  createNotification,
  authHeader,
  generateTimestamps,
  TestUser,
} from './helpers';

const ctx = setupTestApp();

describe('GET /notifications (pagination)', () => {
  let user: TestUser;
  let otherUser: TestUser;
  const timestamps = generateTimestamps(35);

  beforeAll(() => {
    user = createTestUser(ctx.db, { name: 'Alice', username: 'alice' });
    otherUser = createTestUser(ctx.db, { name: 'Bob', username: 'bob' });

    for (let i = 0; i < 35; i++) {
      createNotification(ctx.db, user.id, {
        type: 'nudge',
        fromUserId: otherUser.id,
        message: `Notification ${i + 1}`,
        timestamp: timestamps[i],
        read: i < 5,
      });
    }
  });

  it('returns first page with default limit (20)', async () => {
    const res = await request(ctx.app)
      .get('/notifications')
      .set(authHeader(user))
      .expect(200);

    expect(res.body.data).toHaveLength(20);
    expect(res.body.hasMore).toBe(true);
    expect(res.body.data[0].message).toBe('Notification 1');
    expect(res.body.data[19].message).toBe('Notification 20');
  });

  it('returns second page using cursor', async () => {
    const firstPage = await request(ctx.app)
      .get('/notifications')
      .set(authHeader(user))
      .expect(200);

    const lastTimestamp = firstPage.body.data[firstPage.body.data.length - 1].timestamp;

    const secondPage = await request(ctx.app)
      .get(`/notifications?before=${encodeURIComponent(lastTimestamp)}`)
      .set(authHeader(user))
      .expect(200);

    expect(secondPage.body.data).toHaveLength(15);
    expect(secondPage.body.hasMore).toBe(false);
    expect(secondPage.body.data[0].message).toBe('Notification 21');
    expect(secondPage.body.data[14].message).toBe('Notification 35');
  });

  it('respects custom limit parameter', async () => {
    const res = await request(ctx.app)
      .get('/notifications?limit=5')
      .set(authHeader(user))
      .expect(200);

    expect(res.body.data).toHaveLength(5);
    expect(res.body.hasMore).toBe(true);
  });

  it('clamps limit to max of 50', async () => {
    const res = await request(ctx.app)
      .get('/notifications?limit=100')
      .set(authHeader(user))
      .expect(200);

    expect(res.body.data).toHaveLength(35);
    expect(res.body.hasMore).toBe(false);
  });

  it('clamps limit to min of 1', async () => {
    const res = await request(ctx.app)
      .get('/notifications?limit=0')
      .set(authHeader(user))
      .expect(200);

    expect(res.body.data).toHaveLength(1);
    expect(res.body.hasMore).toBe(true);
  });

  it('returns empty for user with no notifications', async () => {
    const noNotifUser = createTestUser(ctx.db, { username: 'lonely' });
    const res = await request(ctx.app)
      .get('/notifications')
      .set(authHeader(noNotifUser))
      .expect(200);

    expect(res.body.data).toHaveLength(0);
    expect(res.body.hasMore).toBe(false);
  });

  it('returns hasMore=false when cursor is past all data', async () => {
    const res = await request(ctx.app)
      .get('/notifications?before=2000-01-01T00:00:00.000Z')
      .set(authHeader(user))
      .expect(200);

    expect(res.body.data).toHaveLength(0);
    expect(res.body.hasMore).toBe(false);
  });

  it('paginates through all items without duplicates or gaps', async () => {
    const allIds = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;

    while (true) {
      const url = cursor
        ? `/notifications?limit=7&before=${encodeURIComponent(cursor)}`
        : '/notifications?limit=7';

      const res = await request(ctx.app)
        .get(url)
        .set(authHeader(user))
        .expect(200);

      for (const item of res.body.data) {
        expect(allIds.has(item.id)).toBe(false);
        allIds.add(item.id);
      }

      pages++;
      if (!res.body.hasMore) break;
      cursor = res.body.data[res.body.data.length - 1].timestamp;
    }

    expect(allIds.size).toBe(35);
    expect(pages).toBe(5);
  });

  it('does not leak notifications from other users', async () => {
    const res = await request(ctx.app)
      .get('/notifications?limit=50')
      .set(authHeader(otherUser))
      .expect(200);

    expect(res.body.data).toHaveLength(0);
  });

  it('preserves all notification fields', async () => {
    const res = await request(ctx.app)
      .get('/notifications?limit=1')
      .set(authHeader(user))
      .expect(200);

    const n = res.body.data[0];
    expect(n).toHaveProperty('id');
    expect(n).toHaveProperty('type', 'nudge');
    expect(n).toHaveProperty('fromUserId', otherUser.id);
    expect(n).toHaveProperty('message');
    expect(n).toHaveProperty('timestamp');
    expect(typeof n.read).toBe('boolean');
  });

  it('returns 401 without auth', async () => {
    await request(ctx.app).get('/notifications').expect(401);
  });

  it('new items after cursor do not affect next page', async () => {
    const stableUser = createTestUser(ctx.db, { username: 'stable' });
    const ts = generateTimestamps(10, new Date('2025-01-01T00:00:00Z'));
    for (const t of ts) {
      createNotification(ctx.db, stableUser.id, { message: 'old', timestamp: t });
    }

    const page1 = await request(ctx.app)
      .get('/notifications?limit=5')
      .set(authHeader(stableUser))
      .expect(200);

    const cursor = page1.body.data[4].timestamp;

    // Add new notification that's NEWER than cursor
    createNotification(ctx.db, stableUser.id, {
      message: 'new-after-cursor',
      timestamp: new Date('2025-06-01T00:00:00Z').toISOString(),
    });

    const page2 = await request(ctx.app)
      .get(`/notifications?limit=5&before=${encodeURIComponent(cursor)}`)
      .set(authHeader(stableUser))
      .expect(200);

    expect(page2.body.data).toHaveLength(5);
    const hasNew = page2.body.data.some((n: any) => n.message === 'new-after-cursor');
    expect(hasNew).toBe(false);
  });
});

describe('GET /notifications/unread-count', () => {
  it('returns correct unread count', async () => {
    const u = createTestUser(ctx.db, { username: 'counter' });
    for (let i = 0; i < 5; i++) {
      createNotification(ctx.db, u.id, { read: i < 2 });
    }

    const res = await request(ctx.app)
      .get('/notifications/unread-count')
      .set(authHeader(u))
      .expect(200);

    expect(res.body.count).toBe(3);
  });
});

describe('PUT /notifications/read', () => {
  it('marks all as read', async () => {
    const u = createTestUser(ctx.db, { username: 'reader' });
    for (let i = 0; i < 3; i++) {
      createNotification(ctx.db, u.id, { read: false });
    }

    await request(ctx.app)
      .put('/notifications/read')
      .set(authHeader(u))
      .expect(200);

    const res = await request(ctx.app)
      .get('/notifications/unread-count')
      .set(authHeader(u))
      .expect(200);

    expect(res.body.count).toBe(0);
  });
});

describe('Large dataset pagination (200 notifications)', () => {
  let bulkUser: TestUser;

  beforeAll(() => {
    bulkUser = createTestUser(ctx.db, { username: 'bulk' });
    const insert = ctx.db.prepare(
      'INSERT INTO notifications (id, type, from_user_id, pact_id, user_id, message, timestamp, read) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    const { v4: uuid } = require('uuid');
    const insertMany = ctx.db.transaction(() => {
      const base = new Date('2025-01-01T00:00:00.000Z');
      for (let i = 0; i < 200; i++) {
        const ts = new Date(base.getTime() + i * 1000).toISOString();
        insert.run(uuid(), 'nudge', null, null, bulkUser.id, `Bulk ${i + 1}`, ts, 0);
      }
    });
    insertMany();
  });

  it('paginates through 200 items with limit=50', async () => {
    const allIds = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;

    while (true) {
      const url = cursor
        ? `/notifications?limit=50&before=${encodeURIComponent(cursor)}`
        : '/notifications?limit=50';

      const res = await request(ctx.app)
        .get(url)
        .set(authHeader(bulkUser))
        .expect(200);

      for (const item of res.body.data) {
        expect(allIds.has(item.id)).toBe(false);
        allIds.add(item.id);
      }

      pages++;
      if (!res.body.hasMore) break;
      cursor = res.body.data[res.body.data.length - 1].timestamp;
    }

    expect(allIds.size).toBe(200);
    expect(pages).toBe(4);
  });
});
