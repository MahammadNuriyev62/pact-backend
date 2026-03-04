import { Router, Response } from 'express';
import { v4 as uuid } from 'uuid';
import multer from 'multer';
import path from 'path';
import db from '../db';
import { AuthRequest, authMiddleware } from '../middleware/auth';
import { sendPushToUser } from '../push';
import { fullAvatarUrl } from '../utils';

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..');
const uploadsDir = path.join(DATA_DIR, 'uploads');

const avatarStorage = multer.diskStorage({
  destination: uploadsDir,
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `avatar-${uuid()}${ext}`);
  },
});

const avatarUpload = multer({ storage: avatarStorage, limits: { fileSize: 5 * 1024 * 1024 } });

const router = Router();

// Simple per-user rate limiter for search
const searchRateLimit = new Map<string, number[]>();
const SEARCH_WINDOW_MS = 60_000; // 1 minute
const SEARCH_MAX_REQUESTS = 30;  // 30 requests per minute per user

function isSearchRateLimited(userId: string): boolean {
  const now = Date.now();
  const timestamps = (searchRateLimit.get(userId) || []).filter(t => now - t < SEARCH_WINDOW_MS);
  if (timestamps.length >= SEARCH_MAX_REQUESTS) return true;
  timestamps.push(now);
  searchRateLimit.set(userId, timestamps);
  return false;
}

// Cleanup stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [userId, timestamps] of searchRateLimit) {
    const active = timestamps.filter(t => now - t < SEARCH_WINDOW_MS);
    if (active.length === 0) searchRateLimit.delete(userId);
    else searchRateLimit.set(userId, active);
  }
}, 5 * 60_000);

// GET /users — returns only accepted friends
router.get('/', authMiddleware, (req: AuthRequest, res: Response) => {
  const friends = db.prepare(`
    SELECT u.id, u.name, u.username, u.avatar
    FROM users u
    INNER JOIN friendships f ON (
      (f.requester_id = ? AND f.addressee_id = u.id)
      OR (f.addressee_id = ? AND f.requester_id = u.id)
    )
    WHERE f.status = 'accepted' AND u.id != ?
  `).all(req.userId!, req.userId!, req.userId!) as any[];

  res.json(friends.map(f => ({ ...f, avatar: fullAvatarUrl(f.avatar, req) })));
});

// PUT /users/me/avatar — upload a new profile avatar
router.put('/me/avatar', authMiddleware, avatarUpload.single('avatar'), (req: AuthRequest, res: Response) => {
  if (!req.file) {
    res.status(400).json({ error: 'avatar file is required' });
    return;
  }

  const avatarPath = `/uploads/${req.file.filename}`;
  db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(avatarPath, req.userId!);

  const baseUrl = `${req.protocol}://${req.get('host')}`;
  res.json({ avatar: `${baseUrl}${avatarPath}` });
});

// GET /users/search?q=... — search users by name or username (rate limited)
router.get('/search', authMiddleware, (req: AuthRequest, res: Response) => {
  if (isSearchRateLimited(req.userId!)) {
    res.status(429).json({ error: 'Too many search requests. Please slow down.' });
    return;
  }

  const q = (req.query.q as string || '').trim();
  if (!q || q.length < 2) {
    res.json([]);
    return;
  }

  const pattern = `%${q}%`;
  const users = db.prepare(`
    SELECT u.id, u.name, u.username, u.avatar,
      CASE
        WHEN f.status IS NOT NULL THEN f.status
        ELSE 'none'
      END as friendship_status,
      CASE
        WHEN f.requester_id = ? THEN 'outgoing'
        WHEN f.addressee_id = ? THEN 'incoming'
        ELSE NULL
      END as friendship_direction,
      f.id as friendship_id
    FROM users u
    LEFT JOIN friendships f ON (
      (f.requester_id = ? AND f.addressee_id = u.id)
      OR (f.addressee_id = ? AND f.requester_id = u.id)
    )
    WHERE u.id != ? AND (u.name LIKE ? OR u.username LIKE ?)
    LIMIT 20
  `).all(
    req.userId!, req.userId!,
    req.userId!, req.userId!,
    req.userId!, pattern, pattern
  ) as any[];

  res.json(users.map(u => ({
    id: u.id,
    name: u.name,
    username: u.username,
    avatar: fullAvatarUrl(u.avatar, req),
    friendshipStatus: u.friendship_status,
    friendshipDirection: u.friendship_direction,
    friendshipId: u.friendship_id,
  })));
});

// POST /users/friend-request — send a friend request
router.post('/friend-request', authMiddleware, (req: AuthRequest, res: Response) => {
  const { userId: targetUserId } = req.body;
  if (!targetUserId) {
    res.status(400).json({ error: 'userId is required' });
    return;
  }

  if (targetUserId === req.userId) {
    res.status(400).json({ error: 'Cannot send friend request to yourself' });
    return;
  }

  // Check target user exists
  const targetUser = db.prepare('SELECT id FROM users WHERE id = ?').get(targetUserId);
  if (!targetUser) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  // Check if friendship already exists (in either direction)
  const existing = db.prepare(`
    SELECT id, status FROM friendships
    WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)
  `).get(req.userId!, targetUserId, targetUserId, req.userId!) as any;

  if (existing) {
    if (existing.status === 'accepted') {
      res.status(409).json({ error: 'Already friends' });
      return;
    }
    if (existing.status === 'pending') {
      res.status(409).json({ error: 'Friend request already pending' });
      return;
    }
    // If declined, allow re-request by updating
    db.prepare('UPDATE friendships SET status = ?, requester_id = ?, addressee_id = ?, created_at = ? WHERE id = ?')
      .run('pending', req.userId!, targetUserId, new Date().toISOString(), existing.id);

    // Create notification
    const fromUser = db.prepare('SELECT name FROM users WHERE id = ?').get(req.userId!) as any;
    const friendReqMsg = `${fromUser.name} sent you a friend request`;
    db.prepare(
      'INSERT INTO notifications (id, type, from_user_id, pact_id, user_id, message, timestamp) VALUES (?, ?, ?, NULL, ?, ?, ?)'
    ).run(uuid(), 'friend_request', req.userId!, targetUserId, friendReqMsg, new Date().toISOString());
    sendPushToUser(targetUserId, {
      title: 'Friend Request',
      body: friendReqMsg,
      icon: '/icon-192x192.png',
      url: '/notifications',
      tag: `friend-request-${req.userId}`,
    });

    res.json({ success: true, friendshipId: existing.id });
    return;
  }

  const id = uuid();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO friendships (id, requester_id, addressee_id, status, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, req.userId!, targetUserId, 'pending', now);

  // Create notification for the target user
  const fromUser = db.prepare('SELECT name FROM users WHERE id = ?').get(req.userId!) as any;
  const friendReqMsg = `${fromUser.name} sent you a friend request`;
  db.prepare(
    'INSERT INTO notifications (id, type, from_user_id, pact_id, user_id, message, timestamp) VALUES (?, ?, ?, NULL, ?, ?, ?)'
  ).run(uuid(), 'friend_request', req.userId!, targetUserId, friendReqMsg, now);
  sendPushToUser(targetUserId, {
    title: 'Friend Request',
    body: friendReqMsg,
    icon: '/icon-192x192.png',
    url: '/notifications',
    tag: `friend-request-${req.userId}`,
  });

  res.status(201).json({ success: true, friendshipId: id });
});

// POST /users/friend-accept — accept a friend request
router.post('/friend-accept', authMiddleware, (req: AuthRequest, res: Response) => {
  const { friendshipId } = req.body;
  if (!friendshipId) {
    res.status(400).json({ error: 'friendshipId is required' });
    return;
  }

  const friendship = db.prepare(
    'SELECT * FROM friendships WHERE id = ? AND addressee_id = ? AND status = ?'
  ).get(friendshipId, req.userId!, 'pending') as any;

  if (!friendship) {
    res.status(404).json({ error: 'Pending friend request not found' });
    return;
  }

  db.prepare('UPDATE friendships SET status = ? WHERE id = ?').run('accepted', friendshipId);

  // Notify the requester
  const fromUser = db.prepare('SELECT name FROM users WHERE id = ?').get(req.userId!) as any;
  const acceptMsg = `${fromUser.name} accepted your friend request`;
  db.prepare(
    'INSERT INTO notifications (id, type, from_user_id, pact_id, user_id, message, timestamp) VALUES (?, ?, ?, NULL, ?, ?, ?)'
  ).run(uuid(), 'friend_accepted', req.userId!, friendship.requester_id, acceptMsg, new Date().toISOString());
  sendPushToUser(friendship.requester_id, {
    title: 'Friend Accepted',
    body: acceptMsg,
    icon: '/icon-192x192.png',
    url: '/notifications',
    tag: `friend-accepted-${req.userId}`,
  });

  res.json({ success: true });
});

// POST /users/friend-decline — decline a friend request
router.post('/friend-decline', authMiddleware, (req: AuthRequest, res: Response) => {
  const { friendshipId } = req.body;
  if (!friendshipId) {
    res.status(400).json({ error: 'friendshipId is required' });
    return;
  }

  const friendship = db.prepare(
    'SELECT * FROM friendships WHERE id = ? AND addressee_id = ? AND status = ?'
  ).get(friendshipId, req.userId!, 'pending') as any;

  if (!friendship) {
    res.status(404).json({ error: 'Pending friend request not found' });
    return;
  }

  db.prepare('UPDATE friendships SET status = ? WHERE id = ?').run('declined', friendshipId);
  res.json({ success: true });
});

// DELETE /users/friend/:userId — remove a friend
router.delete('/friend/:userId', authMiddleware, (req: AuthRequest, res: Response) => {
  const targetUserId = req.params.userId;

  const result = db.prepare(`
    DELETE FROM friendships
    WHERE status = 'accepted' AND (
      (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)
    )
  `).run(req.userId!, targetUserId, targetUserId, req.userId!);

  if (result.changes === 0) {
    res.status(404).json({ error: 'Friendship not found' });
    return;
  }

  res.json({ success: true });
});

// GET /users/friend-requests — get pending incoming friend requests
router.get('/friend-requests', authMiddleware, (req: AuthRequest, res: Response) => {
  const requests = db.prepare(`
    SELECT f.id as friendship_id, u.id, u.name, u.username, u.avatar, f.created_at
    FROM friendships f
    INNER JOIN users u ON u.id = f.requester_id
    WHERE f.addressee_id = ? AND f.status = 'pending'
    ORDER BY f.created_at DESC
  `).all(req.userId!) as any[];

  res.json(requests.map(r => ({
    friendshipId: r.friendship_id,
    id: r.id,
    name: r.name,
    username: r.username,
    avatar: fullAvatarUrl(r.avatar, req),
    createdAt: r.created_at,
  })));
});

export default router;
