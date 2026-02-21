import { Router, Response } from 'express';
import { v4 as uuid } from 'uuid';
import db from '../db';
import { AuthRequest, authMiddleware } from '../middleware/auth';

const router = Router();

// Send nudge to a participant (or all pending participants)
router.post('/:pactId', authMiddleware, (req: AuthRequest, res: Response) => {
  const { pactId } = req.params;
  const { targetUserId } = req.body; // optional: nudge specific user, or all pending if omitted

  const pact = db.prepare('SELECT * FROM pacts WHERE id = ?').get(pactId) as any;
  if (!pact) {
    res.status(404).json({ error: 'Pact not found' });
    return;
  }

  const fromUser = db.prepare('SELECT name FROM users WHERE id = ?').get(req.userId!) as any;
  const timestamp = new Date().toISOString();

  const insertNotif = db.prepare(`
    INSERT INTO notifications (id, type, from_user_id, pact_id, user_id, message, timestamp, read)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0)
  `);

  if (targetUserId) {
    // Nudge specific user
    insertNotif.run(
      uuid(),
      'nudge',
      req.userId!,
      pactId,
      targetUserId,
      `${fromUser.name} nudged you: Don't break the streak! Complete ${pact.title}!`,
      timestamp,
    );
    res.json({ success: true, nudged: [targetUserId] });
  } else {
    // Nudge all pending participants (those who haven't submitted today)
    const today = new Date().toISOString().split('T')[0];

    const participants = db.prepare(
      'SELECT user_id FROM pact_participants WHERE pact_id = ? AND user_id != ?'
    ).all(pactId, req.userId!) as any[];

    const todaySubmitters = db.prepare(
      "SELECT DISTINCT user_id FROM submissions WHERE pact_id = ? AND substr(timestamp, 1, 10) = ?"
    ).all(pactId, today) as any[];

    const submittedSet = new Set(todaySubmitters.map((s: any) => s.user_id));
    const pending = participants.filter(p => !submittedSet.has(p.user_id));

    for (const p of pending) {
      insertNotif.run(
        uuid(),
        'nudge',
        req.userId!,
        pactId,
        p.user_id,
        `${fromUser.name} nudged you: Don't break the streak! Complete ${pact.title}!`,
        timestamp,
      );
    }

    res.json({ success: true, nudged: pending.map((p: any) => p.user_id) });
  }
});

export default router;
