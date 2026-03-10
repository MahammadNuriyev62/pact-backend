/**
 * Tests for profile editing (PUT /auth/profile), account deletion (DELETE /auth/account),
 * and public user profile (GET /users/:id/profile).
 */
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import {
  setupTestApp,
  createTestUser,
  createTestPact,
  addParticipant,
  createSubmission,
  createNotification,
  createFriendship,
  authHeader,
} from './helpers';

const ctx = setupTestApp();

// ─── PUT /auth/profile ──────────────────────────────────────────────────────

describe('PUT /auth/profile', () => {
  it('updates name successfully', async () => {
    const user = createTestUser(ctx.db);
    const res = await request(ctx.app)
      .put('/auth/profile')
      .set(authHeader(user))
      .send({ name: 'New Name' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('New Name');
    expect(res.body.isCurrentUser).toBe(true);
  });

  it('updates username successfully', async () => {
    const user = createTestUser(ctx.db);
    const res = await request(ctx.app)
      .put('/auth/profile')
      .set(authHeader(user))
      .send({ username: 'new_username' });
    expect(res.status).toBe(200);
    expect(res.body.username).toBe('new_username');
  });

  it('updates bio successfully', async () => {
    const user = createTestUser(ctx.db);
    const res = await request(ctx.app)
      .put('/auth/profile')
      .set(authHeader(user))
      .send({ bio: 'Hello world!' });
    expect(res.status).toBe(200);
    expect(res.body.bio).toBe('Hello world!');
  });

  it('updates all fields at once', async () => {
    const user = createTestUser(ctx.db);
    const res = await request(ctx.app)
      .put('/auth/profile')
      .set(authHeader(user))
      .send({ name: 'Full Name', username: 'full_user', bio: 'Full bio' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Full Name');
    expect(res.body.username).toBe('full_user');
    expect(res.body.bio).toBe('Full bio');
  });

  it('rejects empty body', async () => {
    const user = createTestUser(ctx.db);
    const res = await request(ctx.app)
      .put('/auth/profile')
      .set(authHeader(user))
      .send({});
    expect(res.status).toBe(400);
  });

  it('rejects duplicate username', async () => {
    const user1 = createTestUser(ctx.db, { username: 'taken_name' });
    const user2 = createTestUser(ctx.db);
    const res = await request(ctx.app)
      .put('/auth/profile')
      .set(authHeader(user2))
      .send({ username: 'taken_name' });
    expect(res.status).toBe(409);
    expect(res.body.field).toBe('username');
  });

  it('rejects invalid username format', async () => {
    const user = createTestUser(ctx.db);
    const res = await request(ctx.app)
      .put('/auth/profile')
      .set(authHeader(user))
      .send({ username: 'NO SPACES' });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('username');
  });

  it('rejects username too short', async () => {
    const user = createTestUser(ctx.db);
    const res = await request(ctx.app)
      .put('/auth/profile')
      .set(authHeader(user))
      .send({ username: 'ab' });
    expect(res.status).toBe(400);
  });

  it('rejects too-long bio', async () => {
    const user = createTestUser(ctx.db);
    const res = await request(ctx.app)
      .put('/auth/profile')
      .set(authHeader(user))
      .send({ bio: 'x'.repeat(161) });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('bio');
  });

  it('rejects empty name', async () => {
    const user = createTestUser(ctx.db);
    const res = await request(ctx.app)
      .put('/auth/profile')
      .set(authHeader(user))
      .send({ name: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('name');
  });

  it('trims whitespace from all fields', async () => {
    const user = createTestUser(ctx.db);
    const res = await request(ctx.app)
      .put('/auth/profile')
      .set(authHeader(user))
      .send({ name: '  Trimmed  ', bio: '  trimmed bio  ' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Trimmed');
    expect(res.body.bio).toBe('trimmed bio');
  });

  it('requires auth', async () => {
    const res = await request(ctx.app)
      .put('/auth/profile')
      .send({ name: 'Hacker' });
    expect(res.status).toBe(401);
  });

  it('GET /auth/me returns bio field', async () => {
    const user = createTestUser(ctx.db);
    // Set bio first
    await request(ctx.app)
      .put('/auth/profile')
      .set(authHeader(user))
      .send({ bio: 'My bio' });

    const res = await request(ctx.app)
      .get('/auth/me')
      .set(authHeader(user));
    expect(res.status).toBe(200);
    expect(res.body.bio).toBe('My bio');
  });
});

// ─── DELETE /auth/account ───────────────────────────────────────────────────

describe('DELETE /auth/account', () => {
  it('deletes user and returns success', async () => {
    const user = createTestUser(ctx.db);
    const res = await request(ctx.app)
      .delete('/auth/account')
      .set(authHeader(user));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Verify user is gone
    const row = ctx.db.prepare('SELECT id FROM users WHERE id = ?').get(user.id);
    expect(row).toBeUndefined();
  });

  it('deletes submissions by user', async () => {
    const user = createTestUser(ctx.db);
    const pact = createTestPact(ctx.db, user.id);
    createSubmission(ctx.db, pact.id, user.id);

    await request(ctx.app).delete('/auth/account').set(authHeader(user));

    const subs = ctx.db.prepare('SELECT id FROM submissions WHERE user_id = ?').all(user.id);
    expect(subs.length).toBe(0);
  });

  it('deletes reactions by user', async () => {
    const user = createTestUser(ctx.db);
    const other = createTestUser(ctx.db);
    const pact = createTestPact(ctx.db, other.id);
    addParticipant(ctx.db, pact.id, user.id);
    const subId = createSubmission(ctx.db, pact.id, other.id);

    // Add a reaction
    const { v4: uuid } = require('uuid');
    ctx.db.prepare('INSERT INTO reactions (id, submission_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(uuid(), subId, user.id, '🔥', new Date().toISOString());

    await request(ctx.app).delete('/auth/account').set(authHeader(user));

    const reactions = ctx.db.prepare('SELECT id FROM reactions WHERE user_id = ?').all(user.id);
    expect(reactions.length).toBe(0);
  });

  it('deletes notifications for user', async () => {
    const user = createTestUser(ctx.db);
    createNotification(ctx.db, user.id);

    await request(ctx.app).delete('/auth/account').set(authHeader(user));

    const notifs = ctx.db.prepare('SELECT id FROM notifications WHERE user_id = ?').all(user.id);
    expect(notifs.length).toBe(0);
  });

  it('deletes friendships', async () => {
    const user = createTestUser(ctx.db);
    const friend = createTestUser(ctx.db);
    createFriendship(ctx.db, user.id, friend.id);

    await request(ctx.app).delete('/auth/account').set(authHeader(user));

    const friendships = ctx.db.prepare('SELECT id FROM friendships WHERE requester_id = ? OR addressee_id = ?').all(user.id, user.id);
    expect(friendships.length).toBe(0);
  });

  it('deletes streak freezes', async () => {
    const user = createTestUser(ctx.db);
    const pact = createTestPact(ctx.db, user.id);
    const { v4: uuid } = require('uuid');
    ctx.db.prepare('INSERT INTO streak_freezes (id, pact_id, user_id, used_for_date, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(uuid(), pact.id, user.id, '2026-01-01', new Date().toISOString());

    await request(ctx.app).delete('/auth/account').set(authHeader(user));

    const freezes = ctx.db.prepare('SELECT id FROM streak_freezes WHERE user_id = ?').all(user.id);
    expect(freezes.length).toBe(0);
  });

  it('deletes messages by user', async () => {
    const user = createTestUser(ctx.db);
    const pact = createTestPact(ctx.db, user.id);
    const { v4: uuid } = require('uuid');
    ctx.db.prepare('INSERT INTO messages (id, pact_id, user_id, text, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(uuid(), pact.id, user.id, 'Hello', new Date().toISOString());

    await request(ctx.app).delete('/auth/account').set(authHeader(user));

    const msgs = ctx.db.prepare('SELECT id FROM messages WHERE user_id = ?').all(user.id);
    expect(msgs.length).toBe(0);
  });

  it('transfers pact ownership when other participants exist', async () => {
    const creator = createTestUser(ctx.db);
    const member = createTestUser(ctx.db);
    const pact = createTestPact(ctx.db, creator.id);
    addParticipant(ctx.db, pact.id, member.id);

    await request(ctx.app).delete('/auth/account').set(authHeader(creator));

    // Pact should still exist with new owner
    const pactRow = ctx.db.prepare('SELECT created_by FROM pacts WHERE id = ?').get(pact.id) as any;
    expect(pactRow).toBeDefined();
    expect(pactRow.created_by).toBe(member.id);
  });

  it('deletes pact when user is sole participant', async () => {
    const user = createTestUser(ctx.db);
    const pact = createTestPact(ctx.db, user.id);

    await request(ctx.app).delete('/auth/account').set(authHeader(user));

    const pactRow = ctx.db.prepare('SELECT id FROM pacts WHERE id = ?').get(pact.id);
    expect(pactRow).toBeUndefined();
  });

  it('removes user from pacts they did not create', async () => {
    const creator = createTestUser(ctx.db);
    const member = createTestUser(ctx.db);
    const pact = createTestPact(ctx.db, creator.id);
    addParticipant(ctx.db, pact.id, member.id);

    await request(ctx.app).delete('/auth/account').set(authHeader(member));

    // Pact still exists
    const pactRow = ctx.db.prepare('SELECT id FROM pacts WHERE id = ?').get(pact.id);
    expect(pactRow).toBeDefined();

    // Member removed from participants
    const pp = ctx.db.prepare('SELECT user_id FROM pact_participants WHERE pact_id = ? AND user_id = ?').get(pact.id, member.id);
    expect(pp).toBeUndefined();
  });

  it('requires auth', async () => {
    const res = await request(ctx.app).delete('/auth/account');
    expect(res.status).toBe(401);
  });

  it('handles user with no data gracefully', async () => {
    const user = createTestUser(ctx.db);
    const res = await request(ctx.app)
      .delete('/auth/account')
      .set(authHeader(user));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('nullifies from_user_id on notifications sent to others', async () => {
    const sender = createTestUser(ctx.db);
    const receiver = createTestUser(ctx.db);
    const notifId = createNotification(ctx.db, receiver.id, { fromUserId: sender.id });

    await request(ctx.app).delete('/auth/account').set(authHeader(sender));

    const notif = ctx.db.prepare('SELECT from_user_id FROM notifications WHERE id = ?').get(notifId) as any;
    expect(notif).toBeDefined();
    expect(notif.from_user_id).toBeNull();
  });
});

// ─── GET /users/:id/profile ─────────────────────────────────────────────────

describe('GET /users/:id/profile', () => {
  it('returns profile for a friend', async () => {
    const user = createTestUser(ctx.db);
    const friend = createTestUser(ctx.db, { name: 'My Friend' });
    createFriendship(ctx.db, user.id, friend.id);

    // Set bio for the friend
    ctx.db.prepare('UPDATE users SET bio = ? WHERE id = ?').run('A cool bio', friend.id);

    const res = await request(ctx.app)
      .get(`/users/${friend.id}/profile`)
      .set(authHeader(user));
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('My Friend');
    expect(res.body.bio).toBe('A cool bio');
    expect(res.body.stats).toBeDefined();
    expect(res.body.stats.totalPacts).toBeDefined();
    expect(res.body.stats.totalSubmissions).toBeDefined();
    expect(res.body.activityMap).toBeDefined();
    expect(res.body.sharedPacts).toBeDefined();
    expect(res.body.friendshipStatus).toBe('accepted');
  });

  it('returns profile for a pact member (not friend)', async () => {
    const user = createTestUser(ctx.db);
    const member = createTestUser(ctx.db);
    const pact = createTestPact(ctx.db, user.id);
    addParticipant(ctx.db, pact.id, member.id);

    const res = await request(ctx.app)
      .get(`/users/${member.id}/profile`)
      .set(authHeader(user));
    expect(res.status).toBe(200);
    expect(res.body.sharedPacts.length).toBe(1);
    expect(res.body.friendshipStatus).toBe('none');
  });

  it('rejects profile view for non-connected user', async () => {
    const user = createTestUser(ctx.db);
    const stranger = createTestUser(ctx.db);

    const res = await request(ctx.app)
      .get(`/users/${stranger.id}/profile`)
      .set(authHeader(user));
    expect(res.status).toBe(403);
  });

  it('returns own profile', async () => {
    const user = createTestUser(ctx.db);
    const res = await request(ctx.app)
      .get(`/users/${user.id}/profile`)
      .set(authHeader(user));
    expect(res.status).toBe(200);
    expect(res.body.friendshipStatus).toBe('self');
  });

  it('returns 404 for nonexistent user', async () => {
    const user = createTestUser(ctx.db);
    const res = await request(ctx.app)
      .get('/users/nonexistent-id/profile')
      .set(authHeader(user));
    expect(res.status).toBe(404);
  });

  it('includes activity map data', async () => {
    const user = createTestUser(ctx.db);
    const friend = createTestUser(ctx.db);
    createFriendship(ctx.db, user.id, friend.id);
    const pact = createTestPact(ctx.db, friend.id);
    addParticipant(ctx.db, pact.id, user.id);
    createSubmission(ctx.db, pact.id, friend.id, '2026-03-01T12:00:00.000Z');
    createSubmission(ctx.db, pact.id, friend.id, '2026-03-01T14:00:00.000Z');

    const res = await request(ctx.app)
      .get(`/users/${friend.id}/profile`)
      .set(authHeader(user));
    expect(res.status).toBe(200);
    expect(res.body.activityMap['2026-03-01']).toBe(2);
  });

  it('requires auth', async () => {
    const res = await request(ctx.app).get('/users/some-id/profile');
    expect(res.status).toBe(401);
  });
});
