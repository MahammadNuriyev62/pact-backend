import { Router, Response } from 'express';
import { v4 as uuid } from 'uuid';
import db from '../db';
import { AuthRequest, authMiddleware } from '../middleware/auth';

const router = Router();

function getPactWithDetails(pactId: string, currentUserId: string) {
  const pact = db.prepare('SELECT * FROM pacts WHERE id = ?').get(pactId) as any;
  if (!pact) return null;

  const participants = db.prepare(`
    SELECT u.id, u.name, u.username, u.avatar
    FROM pact_participants pp
    JOIN users u ON u.id = pp.user_id
    WHERE pp.pact_id = ? AND pp.status = 'accepted'
  `).all(pactId) as any[];

  const pending = db.prepare(`
    SELECT u.id, u.name, u.username, u.avatar
    FROM pact_participants pp
    JOIN users u ON u.id = pp.user_id
    WHERE pp.pact_id = ? AND pp.status = 'pending'
  `).all(pactId) as any[];

  // Mark current user
  const participantsWithFlag = participants.map(p => ({
    ...p,
    isCurrentUser: p.id === currentUserId,
  }));

  return {
    id: pact.id,
    title: pact.title,
    icon: pact.icon,
    iconFamily: pact.icon_family,
    color: pact.color,
    frequency: pact.frequency,
    timesPerWeek: pact.times_per_week,
    participants: participantsWithFlag.map(p => p.id),
    participantDetails: participantsWithFlag,
    pendingParticipants: pending,
    createdBy: pact.created_by,
    createdAt: pact.created_at,
    deadline: pact.deadline,
  };
}

// List current user's pacts (only accepted)
router.get('/', authMiddleware, (req: AuthRequest, res: Response) => {
  const pactIds = db.prepare(`
    SELECT pact_id FROM pact_participants WHERE user_id = ? AND status = 'accepted'
  `).all(req.userId!) as any[];

  const pacts = pactIds
    .map(row => getPactWithDetails(row.pact_id, req.userId!))
    .filter(Boolean);

  res.json(pacts);
});

// Get single pact detail
router.get('/:id', authMiddleware, (req: AuthRequest, res: Response) => {
  const pact = getPactWithDetails(req.params.id, req.userId!);
  if (!pact) {
    res.status(404).json({ error: 'Pact not found' });
    return;
  }
  res.json(pact);
});

// Create a new pact
router.post('/', authMiddleware, (req: AuthRequest, res: Response) => {
  const { title, icon, iconFamily, color, frequency, timesPerWeek, deadline, participants } = req.body;

  if (!title || !icon) {
    res.status(400).json({ error: 'title and icon are required' });
    return;
  }

  const id = uuid();
  const now = new Date().toISOString().split('T')[0];

  db.prepare(`
    INSERT INTO pacts (id, title, icon, icon_family, color, frequency, times_per_week, deadline, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    title,
    icon,
    iconFamily || 'Ionicons',
    color || '#4ECDC4',
    frequency || 'daily',
    timesPerWeek || null,
    deadline || '23:59',
    req.userId!,
    now,
  );

  // Add creator as participant (auto-accepted)
  db.prepare('INSERT INTO pact_participants (pact_id, user_id, status) VALUES (?, ?, ?)').run(id, req.userId!, 'accepted');

  // Add other participants as pending with invitation notifications
  const addParticipant = db.prepare('INSERT OR IGNORE INTO pact_participants (pact_id, user_id, status) VALUES (?, ?, ?)');
  const insertNotif = db.prepare(`
    INSERT INTO notifications (id, type, from_user_id, pact_id, user_id, message, timestamp, read)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0)
  `);
  const fromUser = db.prepare('SELECT name FROM users WHERE id = ?').get(req.userId!) as any;
  const timestamp = new Date().toISOString();

  if (participants && Array.isArray(participants)) {
    for (const userId of participants) {
      addParticipant.run(id, userId, 'pending');
      insertNotif.run(
        uuid(),
        'pact_invitation',
        req.userId!,
        id,
        userId,
        `${fromUser.name} invited you to join "${title}"`,
        timestamp,
      );
    }
  }

  const pact = getPactWithDetails(id, req.userId!);
  res.status(201).json(pact);
});

// Leave a pact ("Give Up")
router.post('/:id/leave', authMiddleware, (req: AuthRequest, res: Response) => {
  const pactId = req.params.id;

  const membership = db.prepare(
    `SELECT 1 FROM pact_participants WHERE pact_id = ? AND user_id = ? AND status = 'accepted'`
  ).get(pactId, req.userId!) as any;

  if (!membership) {
    res.status(404).json({ error: 'You are not an active participant of this pact' });
    return;
  }

  db.prepare(
    'UPDATE pact_participants SET status = ? WHERE pact_id = ? AND user_id = ?'
  ).run('left', pactId, req.userId!);

  // If no accepted participants remain, delete the pact
  const remaining = db.prepare(
    `SELECT COUNT(*) as count FROM pact_participants WHERE pact_id = ? AND status = 'accepted'`
  ).get(pactId) as any;

  if (remaining.count === 0) {
    db.prepare('DELETE FROM pacts WHERE id = ?').run(pactId);
  }

  res.json({ success: true });
});

// Get submissions for a pact
router.get('/:id/submissions', authMiddleware, (req: AuthRequest, res: Response) => {
  const subs = db.prepare(`
    SELECT s.*, u.name as user_name, u.username, u.avatar as user_avatar
    FROM submissions s
    JOIN users u ON u.id = s.user_id
    WHERE s.pact_id = ?
    ORDER BY s.timestamp DESC
  `).all(req.params.id) as any[];

  const baseUrl = `${req.protocol}://${req.get('host')}`;
  res.json(subs.map(s => ({
    id: s.id,
    pactId: s.pact_id,
    userId: s.user_id,
    photoUri: s.photo_uri.startsWith('/') ? `${baseUrl}${s.photo_uri}` : s.photo_uri,
    timestamp: s.timestamp,
    verified: !!s.verified,
    user: { id: s.user_id, name: s.user_name, username: s.username, avatar: s.user_avatar },
  })));
});

export default router;
