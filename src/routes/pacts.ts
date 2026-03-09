import { Router, Response } from 'express';
import { v4 as uuid } from 'uuid';
import db from '../db';
import { AuthRequest, authMiddleware } from '../middleware/auth';
import { sendPushToUser } from '../push';
import { fullAvatarUrl } from '../utils';
import { getTodayInTimezone, utcTimestampToDateInTimezone } from '../timezone';
import { computeStreak } from './streaks';

const router = Router();

function getPactWithDetails(pactId: string, currentUserId: string, req: import('express').Request) {
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
    avatar: fullAvatarUrl(p.avatar, req),
    isCurrentUser: p.id === currentUserId,
  }));

  const pendingWithAvatars = pending.map(p => ({
    ...p,
    avatar: fullAvatarUrl(p.avatar, req),
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
    pendingParticipants: pendingWithAvatars,
    createdBy: pact.created_by,
    createdAt: pact.created_at,
    deadline: pact.deadline,
    timezone: pact.timezone || 'UTC',
  };
}

// List current user's pacts (only accepted)
router.get('/', authMiddleware, (req: AuthRequest, res: Response) => {
  const pactIds = db.prepare(`
    SELECT pact_id FROM pact_participants WHERE user_id = ? AND status = 'accepted'
  `).all(req.userId!) as any[];

  const pacts = pactIds
    .map(row => getPactWithDetails(row.pact_id, req.userId!, req))
    .filter(Boolean);

  res.json(pacts);
});

// Get single pact detail
router.get('/:id', authMiddleware, (req: AuthRequest, res: Response) => {
  const pact = getPactWithDetails(req.params.id, req.userId!, req);
  if (!pact) {
    res.status(404).json({ error: 'Pact not found' });
    return;
  }
  res.json(pact);
});

// Create a new pact
router.post('/', authMiddleware, (req: AuthRequest, res: Response) => {
  const { title, icon, iconFamily, color, frequency, timesPerWeek, deadline, timezone, participants } = req.body;

  if (!title || !icon) {
    res.status(400).json({ error: 'title and icon are required' });
    return;
  }

  const id = uuid();
  const now = new Date().toISOString().split('T')[0];

  db.prepare(`
    INSERT INTO pacts (id, title, icon, icon_family, color, frequency, times_per_week, deadline, timezone, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    title,
    icon,
    iconFamily || 'Ionicons',
    color || '#4ECDC4',
    frequency || 'daily',
    timesPerWeek || null,
    deadline || '23:59',
    timezone || 'UTC',
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
      const message = `${fromUser.name} invited you to join "${title}"`;
      insertNotif.run(uuid(), 'pact_invitation', req.userId!, id, userId, message, timestamp);
      sendPushToUser(userId, {
        title: 'Pact Invitation',
        body: message,
        icon: '/icon-192x192.png',
        url: '/notifications',
        tag: `pact-invitation-${id}`,
      });
    }
  }

  const pact = getPactWithDetails(id, req.userId!, req);
  res.status(201).json(pact);
});

// Edit a pact
router.put('/:id', authMiddleware, (req: AuthRequest, res: Response) => {
  const pactId = req.params.id;

  // Verify the pact exists
  const pact = db.prepare('SELECT * FROM pacts WHERE id = ?').get(pactId) as any;
  if (!pact) {
    res.status(404).json({ error: 'Pact not found' });
    return;
  }

  // Verify the user is an accepted participant
  const membership = db.prepare(
    `SELECT 1 FROM pact_participants WHERE pact_id = ? AND user_id = ? AND status = 'accepted'`
  ).get(pactId, req.userId!) as any;

  if (!membership) {
    res.status(403).json({ error: 'You are not an active participant of this pact' });
    return;
  }

  const { title, icon, iconFamily, color, frequency, timesPerWeek } = req.body;

  // Validate that at least one field is provided
  if (title === undefined && icon === undefined && iconFamily === undefined &&
      color === undefined && frequency === undefined && timesPerWeek === undefined) {
    res.status(400).json({ error: 'At least one field to update is required' });
    return;
  }

  // Validate title is not empty if provided
  if (title !== undefined && (!title || typeof title !== 'string' || !title.trim())) {
    res.status(400).json({ error: 'title cannot be empty' });
    return;
  }

  // Validate icon is not empty if provided
  if (icon !== undefined && (!icon || typeof icon !== 'string' || !icon.trim())) {
    res.status(400).json({ error: 'icon cannot be empty' });
    return;
  }

  // Validate frequency value if provided
  if (frequency !== undefined && frequency !== 'daily' && frequency !== 'weekly') {
    res.status(400).json({ error: 'frequency must be "daily" or "weekly"' });
    return;
  }

  // If frequency or timesPerWeek is being changed, check that current streak is 0
  const frequencyChanging = frequency !== undefined && frequency !== pact.frequency;
  const timesPerWeekChanging = timesPerWeek !== undefined && timesPerWeek !== pact.times_per_week;

  if (frequencyChanging || timesPerWeekChanging) {
    // Compute current unified streak (same logic as GET /streaks)
    const tz = pact.timezone || 'UTC';
    const today = getTodayInTimezone(tz);

    const participants = db.prepare(
      `SELECT user_id FROM pact_participants WHERE pact_id = ? AND status = 'accepted'`
    ).all(pactId) as any[];

    // Build per-user effective dates (submissions + freezes)
    const perUserEffective: Map<string, Set<string>> = new Map();
    for (const p of participants) {
      const subs = db.prepare(
        'SELECT timestamp FROM submissions WHERE pact_id = ? AND user_id = ? AND verified = 1'
      ).all(pactId, p.user_id) as any[];
      const dates = new Set(subs.map((s: any) => utcTimestampToDateInTimezone(s.timestamp, tz)));

      const freezeRows = db.prepare(
        'SELECT used_for_date FROM streak_freezes WHERE pact_id = ? AND user_id = ?'
      ).all(pactId, p.user_id) as any[];
      for (const r of freezeRows) dates.add(r.used_for_date);

      perUserEffective.set(p.user_id, dates);
    }

    // Unified completed dates: days where ALL participants have effective coverage
    const allDates = new Set<string>();
    for (const dates of perUserEffective.values()) {
      for (const d of dates) allDates.add(d);
    }

    const unifiedDates: string[] = [];
    for (const date of allDates) {
      let allCovered = true;
      for (const dates of perUserEffective.values()) {
        if (!dates.has(date)) { allCovered = false; break; }
      }
      if (allCovered) unifiedDates.push(date);
    }

    const { currentStreak } = computeStreak(unifiedDates, pact.frequency, today, pact.times_per_week, pact.created_at);

    if (currentStreak > 0) {
      res.status(400).json({ error: 'Cannot change frequency or timesPerWeek while the pact has an active streak' });
      return;
    }
  }

  // Build the UPDATE query dynamically
  const updates: string[] = [];
  const values: any[] = [];

  if (title !== undefined) {
    updates.push('title = ?');
    values.push(title.trim());
  }
  if (icon !== undefined) {
    updates.push('icon = ?');
    values.push(icon.trim());
  }
  if (iconFamily !== undefined) {
    updates.push('icon_family = ?');
    values.push(iconFamily);
  }
  if (color !== undefined) {
    updates.push('color = ?');
    values.push(color);
  }
  if (frequency !== undefined) {
    updates.push('frequency = ?');
    values.push(frequency);
  }
  if (timesPerWeek !== undefined) {
    updates.push('times_per_week = ?');
    values.push(timesPerWeek);
  }

  values.push(pactId);
  db.prepare(`UPDATE pacts SET ${updates.join(', ')} WHERE id = ?`).run(...values);

  const updated = getPactWithDetails(pactId, req.userId!, req);
  res.json(updated);
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

// Invite users to an existing pact
router.post('/:id/invite', authMiddleware, (req: AuthRequest, res: Response) => {
  const pactId = req.params.id;
  const { userIds } = req.body;

  if (!userIds || !Array.isArray(userIds) || userIds.length === 0) {
    res.status(400).json({ error: 'userIds array is required' });
    return;
  }

  // Verify the pact exists and the requester is an accepted participant
  const membership = db.prepare(
    `SELECT 1 FROM pact_participants WHERE pact_id = ? AND user_id = ? AND status = 'accepted'`
  ).get(pactId, req.userId!) as any;

  if (!membership) {
    res.status(403).json({ error: 'You are not an active participant of this pact' });
    return;
  }

  const pact = db.prepare('SELECT title FROM pacts WHERE id = ?').get(pactId) as any;
  const fromUser = db.prepare('SELECT name FROM users WHERE id = ?').get(req.userId!) as any;
  const timestamp = new Date().toISOString();

  const addParticipant = db.prepare('INSERT OR IGNORE INTO pact_participants (pact_id, user_id, status) VALUES (?, ?, ?)');
  const insertNotif = db.prepare(
    'INSERT INTO notifications (id, type, from_user_id, pact_id, user_id, message, timestamp, read) VALUES (?, ?, ?, ?, ?, ?, ?, 0)'
  );

  const invited: string[] = [];
  for (const userId of userIds) {
    // Skip if already a participant (any status)
    const existing = db.prepare('SELECT status FROM pact_participants WHERE pact_id = ? AND user_id = ?').get(pactId, userId) as any;
    if (existing) continue;

    addParticipant.run(pactId, userId, 'pending');
    const message = `${fromUser.name} invited you to join "${pact.title}"`;
    insertNotif.run(uuid(), 'pact_invitation', req.userId!, pactId, userId, message, timestamp);
    sendPushToUser(userId, {
      title: 'Pact Invitation',
      body: message,
      icon: '/icon-192x192.png',
      url: '/notifications',
      tag: `pact-invitation-${pactId}`,
    });
    invited.push(userId);
  }

  res.json({ success: true, invited });
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
  const getReactions = db.prepare(
    `SELECT emoji, COUNT(*) as count, GROUP_CONCAT(user_id) as user_ids FROM reactions WHERE submission_id = ? GROUP BY emoji`
  );

  res.json(subs.map(s => {
    const reactionRows = getReactions.all(s.id) as any[];
    const reactions = reactionRows.map(r => ({
      emoji: r.emoji,
      count: r.count,
      reacted: (r.user_ids as string).split(',').includes(req.userId!),
    }));

    return {
      id: s.id,
      pactId: s.pact_id,
      userId: s.user_id,
      photoUri: s.photo_uri.startsWith('/') ? `${baseUrl}${s.photo_uri}` : s.photo_uri,
      timestamp: s.timestamp,
      verified: !!s.verified,
      user: { id: s.user_id, name: s.user_name, username: s.username, avatar: fullAvatarUrl(s.user_avatar, req) },
      reactions,
    };
  }));
});

export default router;
