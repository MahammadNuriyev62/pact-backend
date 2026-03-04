import { Router, Response } from 'express';
import { v4 as uuid } from 'uuid';
import db from '../db';
import { AuthRequest, authMiddleware } from '../middleware/auth';
import { sendPushToUser } from '../push';
import { fullAvatarUrl } from '../utils';
import { emitNewMessage } from '../socket';

const router = Router();

// Get messages for a pact (cursor-based pagination)
router.get('/:pactId/messages', authMiddleware, (req: AuthRequest, res: Response) => {
  const { pactId } = req.params;
  const before = req.query.before as string | undefined;
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);

  // Permission check
  const participant = db.prepare(
    `SELECT 1 FROM pact_participants WHERE pact_id = ? AND user_id = ? AND status = 'accepted'`
  ).get(pactId, req.userId!);
  if (!participant) {
    res.status(403).json({ error: 'You are not a participant of this pact' });
    return;
  }

  let messages: any[];
  if (before) {
    messages = db.prepare(`
      SELECT m.*, u.name as user_name, u.username, u.avatar as user_avatar
      FROM messages m
      JOIN users u ON u.id = m.user_id
      WHERE m.pact_id = ? AND m.created_at < ?
      ORDER BY m.created_at DESC
      LIMIT ?
    `).all(pactId, before, limit + 1) as any[];
  } else {
    messages = db.prepare(`
      SELECT m.*, u.name as user_name, u.username, u.avatar as user_avatar
      FROM messages m
      JOIN users u ON u.id = m.user_id
      WHERE m.pact_id = ?
      ORDER BY m.created_at DESC
      LIMIT ?
    `).all(pactId, limit + 1) as any[];
  }

  const hasMore = messages.length > limit;
  if (hasMore) messages.pop();

  res.json({
    messages: messages.map(m => ({
      id: m.id,
      pactId: m.pact_id,
      userId: m.user_id,
      text: m.text,
      createdAt: m.created_at,
      user: {
        id: m.user_id,
        name: m.user_name,
        username: m.username,
        avatar: fullAvatarUrl(m.user_avatar, req),
      },
    })),
    hasMore,
  });
});

// Send a message in a pact
router.post('/:pactId/messages', authMiddleware, (req: AuthRequest, res: Response) => {
  const { pactId } = req.params;
  const { text } = req.body;

  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    res.status(400).json({ error: 'text is required' });
    return;
  }

  if (text.length > 1000) {
    res.status(400).json({ error: 'Message too long (max 1000 characters)' });
    return;
  }

  // Permission check
  const participant = db.prepare(
    `SELECT 1 FROM pact_participants WHERE pact_id = ? AND user_id = ? AND status = 'accepted'`
  ).get(pactId, req.userId!);
  if (!participant) {
    res.status(403).json({ error: 'You are not a participant of this pact' });
    return;
  }

  const pact = db.prepare('SELECT title FROM pacts WHERE id = ?').get(pactId) as any;
  if (!pact) {
    res.status(404).json({ error: 'Pact not found' });
    return;
  }

  const id = uuid();
  const createdAt = new Date().toISOString();
  const trimmedText = text.trim();

  db.prepare(
    'INSERT INTO messages (id, pact_id, user_id, text, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, pactId, req.userId!, trimmedText, createdAt);

  const user = db.prepare('SELECT name, username, avatar FROM users WHERE id = ?').get(req.userId!) as any;

  // Notify other participants
  const otherParticipants = db.prepare(
    `SELECT user_id FROM pact_participants WHERE pact_id = ? AND user_id != ? AND status = 'accepted'`
  ).all(pactId, req.userId!) as any[];

  const insertNotif = db.prepare(
    'INSERT INTO notifications (id, type, from_user_id, pact_id, user_id, message, timestamp, read) VALUES (?, ?, ?, ?, ?, ?, ?, 0)'
  );

  const preview = trimmedText.length > 50 ? trimmedText.slice(0, 50) + '...' : trimmedText;
  for (const p of otherParticipants) {
    const notifMessage = `${user.name} in ${pact.title}: ${preview}`;
    insertNotif.run(uuid(), 'chat_message', req.userId!, pactId, p.user_id, notifMessage, createdAt);
    sendPushToUser(p.user_id, {
      title: pact.title,
      body: `${user.name}: ${trimmedText.slice(0, 100)}`,
      icon: '/icon-192x192.png',
      url: `/pact/${pactId}`,
      tag: `chat-${pactId}`,
    });
  }

  const messageObj = {
    id,
    pactId,
    userId: req.userId!,
    text: trimmedText,
    createdAt,
    user: {
      id: req.userId!,
      name: user.name,
      username: user.username,
      avatar: fullAvatarUrl(user.avatar, req),
    },
  };

  // Broadcast via WebSocket to all pact members
  emitNewMessage(pactId, messageObj);

  res.status(201).json(messageObj);
});

export default router;
