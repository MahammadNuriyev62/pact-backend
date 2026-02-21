import { Router, Response } from 'express';
import db from '../db';
import { AuthRequest, authMiddleware } from '../middleware/auth';

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

export default router;
