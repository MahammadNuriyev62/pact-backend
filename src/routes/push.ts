import { Router, Response } from 'express';
import { v4 as uuid } from 'uuid';
import db from '../db';
import { AuthRequest, authMiddleware } from '../middleware/auth';
import { VAPID_PUBLIC_KEY } from '../push';

const router = Router();

// GET /push/vapid-public-key — returns VAPID public key (no auth required)
router.get('/vapid-public-key', (_req, res: Response) => {
  if (!VAPID_PUBLIC_KEY) {
    res.status(503).json({ error: 'Push notifications not configured' });
    return;
  }
  res.json({ key: VAPID_PUBLIC_KEY });
});

// POST /push/subscribe — store/upsert a push subscription for the current user
router.post('/subscribe', authMiddleware, (req: AuthRequest, res: Response) => {
  const { endpoint, keys } = req.body;

  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    res.status(400).json({ error: 'endpoint, keys.p256dh, and keys.auth are required' });
    return;
  }

  const existing = db.prepare('SELECT id FROM push_subscriptions WHERE endpoint = ?').get(endpoint) as any;

  if (existing) {
    db.prepare(
      'UPDATE push_subscriptions SET user_id = ?, p256dh = ?, auth = ?, created_at = ? WHERE id = ?'
    ).run(req.userId!, keys.p256dh, keys.auth, new Date().toISOString(), existing.id);
    res.json({ success: true, id: existing.id });
  } else {
    const id = uuid();
    db.prepare(
      'INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, req.userId!, endpoint, keys.p256dh, keys.auth, new Date().toISOString());
    res.json({ success: true, id });
  }
});

// POST /push/unsubscribe — remove a push subscription
router.post('/unsubscribe', authMiddleware, (req: AuthRequest, res: Response) => {
  const { endpoint } = req.body;

  if (!endpoint) {
    res.status(400).json({ error: 'endpoint is required' });
    return;
  }

  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?')
    .run(endpoint, req.userId!);

  res.json({ success: true });
});

export default router;
