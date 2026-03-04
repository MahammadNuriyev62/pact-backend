import { Router, Response } from 'express';
import { v4 as uuid } from 'uuid';
import db from '../db';
import { AuthRequest, authMiddleware } from '../middleware/auth';
import { fullAvatarUrl } from '../utils';
import { sendPushToUser } from '../push';

const router = Router();

// Get notifications for current user
router.get('/', authMiddleware, (req: AuthRequest, res: Response) => {
  const notifs = db.prepare(`
    SELECT n.*, u.name as from_user_name, u.avatar as from_user_avatar
    FROM notifications n
    LEFT JOIN users u ON u.id = n.from_user_id
    WHERE n.user_id = ?
    ORDER BY n.timestamp DESC
  `).all(req.userId!) as any[];

  res.json(notifs.map(n => ({
    id: n.id,
    type: n.type,
    fromUserId: n.from_user_id,
    fromUserAvatar: fullAvatarUrl(n.from_user_avatar, req),
    pactId: n.pact_id,
    message: n.message,
    timestamp: n.timestamp,
    read: !!n.read,
  })));
});

// Get unread count
router.get('/unread-count', authMiddleware, (req: AuthRequest, res: Response) => {
  const result = db.prepare(
    'SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND read = 0'
  ).get(req.userId!) as any;

  res.json({ count: result.count });
});

// Mark all as read
router.put('/read', authMiddleware, (req: AuthRequest, res: Response) => {
  db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ?').run(req.userId!);
  res.json({ success: true });
});

// Accept a pact invitation
router.post('/:id/accept', authMiddleware, (req: AuthRequest, res: Response) => {
  const notif = db.prepare(
    'SELECT * FROM notifications WHERE id = ? AND user_id = ?'
  ).get(req.params.id, req.userId!) as any;

  if (!notif || notif.type !== 'pact_invitation') {
    res.status(404).json({ error: 'Invitation not found' });
    return;
  }

  // Check pact still exists
  const pact = db.prepare('SELECT 1 FROM pacts WHERE id = ?').get(notif.pact_id);
  if (!pact) {
    res.status(404).json({ error: 'Pact no longer exists' });
    return;
  }

  db.prepare(
    'UPDATE pact_participants SET status = ? WHERE pact_id = ? AND user_id = ?'
  ).run('accepted', notif.pact_id, req.userId!);

  db.prepare('UPDATE notifications SET read = 1 WHERE id = ?').run(req.params.id);

  res.json({ success: true });
});

// Decline a pact invitation
router.post('/:id/decline', authMiddleware, (req: AuthRequest, res: Response) => {
  const notif = db.prepare(
    'SELECT * FROM notifications WHERE id = ? AND user_id = ?'
  ).get(req.params.id, req.userId!) as any;

  if (!notif || notif.type !== 'pact_invitation') {
    res.status(404).json({ error: 'Invitation not found' });
    return;
  }

  db.prepare(
    'UPDATE pact_participants SET status = ? WHERE pact_id = ? AND user_id = ?'
  ).run('declined', notif.pact_id, req.userId!);

  db.prepare('UPDATE notifications SET read = 1 WHERE id = ?').run(req.params.id);

  // Notify the pact creator that the invitation was declined
  const pact = db.prepare('SELECT title, created_by FROM pacts WHERE id = ?').get(notif.pact_id) as any;
  const decliner = db.prepare('SELECT name FROM users WHERE id = ?').get(req.userId!) as any;
  if (pact && decliner) {
    const message = `${decliner.name} declined your invitation to "${pact.title}"`;
    db.prepare(
      'INSERT INTO notifications (id, type, from_user_id, pact_id, user_id, message, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(uuid(), 'pact_declined', req.userId!, notif.pact_id, pact.created_by, message, new Date().toISOString());
    sendPushToUser(pact.created_by, {
      title: 'Invitation Declined',
      body: message,
      icon: '/icon-192x192.png',
      url: '/notifications',
      tag: `pact-declined-${notif.pact_id}-${req.userId}`,
    });
  }

  res.json({ success: true });
});

export default router;
