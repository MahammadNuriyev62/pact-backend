import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import {
  setupTestApp,
  createTestUser,
  createTestPact,
  addParticipant,
  createSubmission,
  authHeader,
  generateTimestamps,
  TestUser,
  TestPact,
} from './helpers';

const ctx = setupTestApp();

// ─────────────────────────────────────────────────────────────────────────────
// GET /pacts/:id/submissions
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /pacts/:id/submissions (pagination)', () => {
  let user: TestUser;
  let pact: TestPact;
  const timestamps = generateTimestamps(30);

  beforeAll(() => {
    user = createTestUser(ctx.db, { name: 'Alice', username: 'alice' });
    pact = createTestPact(ctx.db, user.id, { title: 'Morning Run' });

    for (let i = 0; i < 30; i++) {
      createSubmission(ctx.db, pact.id, user.id, timestamps[i]);
    }
  });

  it('returns first page with default limit (20)', async () => {
    const res = await request(ctx.app)
      .get(`/pacts/${pact.id}/submissions`)
      .set(authHeader(user))
      .expect(200);

    expect(res.body.data).toHaveLength(20);
    expect(res.body.hasMore).toBe(true);
    // Newest first
    for (let i = 0; i < res.body.data.length - 1; i++) {
      expect(res.body.data[i].timestamp >= res.body.data[i + 1].timestamp).toBe(true);
    }
  });

  it('returns second page using cursor', async () => {
    const first = await request(ctx.app)
      .get(`/pacts/${pact.id}/submissions`)
      .set(authHeader(user))
      .expect(200);

    const cursor = first.body.data[first.body.data.length - 1].timestamp;

    const second = await request(ctx.app)
      .get(`/pacts/${pact.id}/submissions?before=${encodeURIComponent(cursor)}`)
      .set(authHeader(user))
      .expect(200);

    expect(second.body.data).toHaveLength(10);
    expect(second.body.hasMore).toBe(false);
  });

  it('respects custom limit', async () => {
    const res = await request(ctx.app)
      .get(`/pacts/${pact.id}/submissions?limit=3`)
      .set(authHeader(user))
      .expect(200);

    expect(res.body.data).toHaveLength(3);
    expect(res.body.hasMore).toBe(true);
  });

  it('returns empty for pact with no submissions', async () => {
    const emptyPact = createTestPact(ctx.db, user.id, { title: 'Empty' });
    const res = await request(ctx.app)
      .get(`/pacts/${emptyPact.id}/submissions`)
      .set(authHeader(user))
      .expect(200);

    expect(res.body.data).toHaveLength(0);
    expect(res.body.hasMore).toBe(false);
  });

  it('paginates through all without duplicates', async () => {
    const allIds = new Set<string>();
    let cursor: string | undefined;

    while (true) {
      const url = cursor
        ? `/pacts/${pact.id}/submissions?limit=8&before=${encodeURIComponent(cursor)}`
        : `/pacts/${pact.id}/submissions?limit=8`;

      const res = await request(ctx.app)
        .get(url)
        .set(authHeader(user))
        .expect(200);

      for (const item of res.body.data) {
        expect(allIds.has(item.id)).toBe(false);
        allIds.add(item.id);
      }

      if (!res.body.hasMore) break;
      cursor = res.body.data[res.body.data.length - 1].timestamp;
    }

    expect(allIds.size).toBe(30);
  });

  it('includes user and reactions fields', async () => {
    const res = await request(ctx.app)
      .get(`/pacts/${pact.id}/submissions?limit=1`)
      .set(authHeader(user))
      .expect(200);

    const s = res.body.data[0];
    expect(s).toHaveProperty('id');
    expect(s).toHaveProperty('pactId', pact.id);
    expect(s).toHaveProperty('userId', user.id);
    expect(s).toHaveProperty('photoUri');
    expect(s).toHaveProperty('timestamp');
    expect(s).toHaveProperty('verified', true);
    expect(s.user).toHaveProperty('id', user.id);
    expect(s.user).toHaveProperty('name');
    expect(Array.isArray(s.reactions)).toBe(true);
  });

  it('handles exactly-limit boundary (no false hasMore)', async () => {
    const bPact = createTestPact(ctx.db, user.id, { title: 'Boundary' });
    const ts = generateTimestamps(5);
    for (const t of ts) createSubmission(ctx.db, bPact.id, user.id, t);

    const res = await request(ctx.app)
      .get(`/pacts/${bPact.id}/submissions?limit=5`)
      .set(authHeader(user))
      .expect(200);

    expect(res.body.data).toHaveLength(5);
    expect(res.body.hasMore).toBe(false);
  });

  it('handles single submission', async () => {
    const sPact = createTestPact(ctx.db, user.id, { title: 'Single' });
    createSubmission(ctx.db, sPact.id, user.id);

    const res = await request(ctx.app)
      .get(`/pacts/${sPact.id}/submissions?limit=20`)
      .set(authHeader(user))
      .expect(200);

    expect(res.body.data).toHaveLength(1);
    expect(res.body.hasMore).toBe(false);
  });

  it('scopes submissions to requested pact only', async () => {
    const otherPact = createTestPact(ctx.db, user.id, { title: 'Other' });
    createSubmission(ctx.db, otherPact.id, user.id);

    const res = await request(ctx.app)
      .get(`/pacts/${otherPact.id}/submissions?limit=50`)
      .set(authHeader(user))
      .expect(200);

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].pactId).toBe(otherPact.id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /submissions/recent
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /submissions/recent (pagination)', () => {
  let user: TestUser;
  let otherUser: TestUser;
  let pact: TestPact;
  const timestamps = generateTimestamps(25);

  beforeAll(() => {
    user = createTestUser(ctx.db, { name: 'Carol', username: 'carol' });
    otherUser = createTestUser(ctx.db, { name: 'Dave', username: 'dave' });
    pact = createTestPact(ctx.db, user.id, { title: 'Recent Test' });
    addParticipant(ctx.db, pact.id, otherUser.id);

    for (let i = 0; i < 25; i++) {
      const submitter = i % 2 === 0 ? user.id : otherUser.id;
      createSubmission(ctx.db, pact.id, submitter, timestamps[i]);
    }
  });

  it('returns first page with default limit (10)', async () => {
    const res = await request(ctx.app)
      .get('/submissions/recent')
      .set(authHeader(user))
      .expect(200);

    expect(res.body.data).toHaveLength(10);
    expect(res.body.hasMore).toBe(true);
  });

  it('paginates through all results', async () => {
    const allIds = new Set<string>();
    let cursor: string | undefined;

    while (true) {
      const url = cursor
        ? `/submissions/recent?limit=10&before=${encodeURIComponent(cursor)}`
        : '/submissions/recent?limit=10';

      const res = await request(ctx.app)
        .get(url)
        .set(authHeader(user))
        .expect(200);

      for (const item of res.body.data) {
        expect(allIds.has(item.id)).toBe(false);
        allIds.add(item.id);
      }

      if (!res.body.hasMore) break;
      cursor = res.body.data[res.body.data.length - 1].timestamp;
    }

    expect(allIds.size).toBe(25);
  });

  it('includes pact and user details', async () => {
    const res = await request(ctx.app)
      .get('/submissions/recent?limit=1')
      .set(authHeader(user))
      .expect(200);

    const s = res.body.data[0];
    expect(s.pact).toHaveProperty('title', pact.title);
    expect(s.pact).toHaveProperty('icon');
    expect(s.pact).toHaveProperty('color');
    expect(s.user).toHaveProperty('name');
  });

  it('only shows submissions from joined pacts', async () => {
    const loner = createTestUser(ctx.db, { username: 'loner' });
    const lonerPact = createTestPact(ctx.db, loner.id, { title: 'Solo' });
    createSubmission(ctx.db, lonerPact.id, loner.id);

    const res = await request(ctx.app)
      .get('/submissions/recent?limit=50')
      .set(authHeader(user))
      .expect(200);

    const lonerSubs = res.body.data.filter((s: any) => s.userId === loner.id);
    expect(lonerSubs).toHaveLength(0);
  });

  it('returns empty when no submissions exist', async () => {
    const newUser = createTestUser(ctx.db, { username: 'newbie' });
    const res = await request(ctx.app)
      .get('/submissions/recent')
      .set(authHeader(newUser))
      .expect(200);

    expect(res.body.data).toHaveLength(0);
    expect(res.body.hasMore).toBe(false);
  });

  it('maintains DESC order across pages', async () => {
    let cursor: string | undefined;
    let prevTimestamp: string | undefined;

    for (let page = 0; page < 3; page++) {
      const url = cursor
        ? `/submissions/recent?limit=10&before=${encodeURIComponent(cursor)}`
        : '/submissions/recent?limit=10';

      const res = await request(ctx.app)
        .get(url)
        .set(authHeader(user))
        .expect(200);

      for (const item of res.body.data) {
        if (prevTimestamp) {
          expect(item.timestamp <= prevTimestamp).toBe(true);
        }
        prevTimestamp = item.timestamp;
      }

      if (!res.body.hasMore) break;
      cursor = res.body.data[res.body.data.length - 1].timestamp;
    }
  });
});
