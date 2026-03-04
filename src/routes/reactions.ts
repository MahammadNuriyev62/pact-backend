import { Router, Response } from 'express';
import { v4 as uuid } from 'uuid';
import db from '../db';
import { AuthRequest, authMiddleware } from '../middleware/auth';
import { sendPushToUser } from '../push';
import { emitReactionUpdate } from '../socket';

const router = Router();

const ALLOWED_EMOJIS = ['👏', '🔥', '💪', '❤️', '😍', '🎉'];

/** Get reaction summary for a submission, with `reacted` flag for the given user */
export function getReactionSummary(submissionId: string, currentUserId: string) {
  const rows = db.prepare(`
    SELECT emoji, COUNT(*) as count, GROUP_CONCAT(user_id) as user_ids
    FROM reactions WHERE submission_id = ? GROUP BY emoji
  `).all(submissionId) as any[];

  return rows.map(r => ({
    emoji: r.emoji,
    count: r.count,
    reacted: (r.user_ids as string).split(',').includes(currentUserId),
  }));
}

// Toggle a reaction on/off
router.post('/', authMiddleware, (req: AuthRequest, res: Response) => {
  const { submissionId, emoji } = req.body;

  if (!submissionId || !emoji) {
    res.status(400).json({ error: 'submissionId and emoji are required' });
    return;
  }

  if (!ALLOWED_EMOJIS.includes(emoji)) {
    res.status(400).json({ error: 'Invalid emoji' });
    return;
  }

  // Verify submission exists
  const submission = db.prepare('SELECT * FROM submissions WHERE id = ?').get(submissionId) as any;
  if (!submission) {
    res.status(404).json({ error: 'Submission not found' });
    return;
  }

  // Permission: user must be accepted participant of the submission's pact
  const participant = db.prepare(
    `SELECT 1 FROM pact_participants WHERE pact_id = ? AND user_id = ? AND status = 'accepted'`
  ).get(submission.pact_id, req.userId!);
  if (!participant) {
    res.status(403).json({ error: 'You are not a participant of this pact' });
    return;
  }

  // Check if reaction already exists
  const existing = db.prepare(
    'SELECT id FROM reactions WHERE submission_id = ? AND user_id = ? AND emoji = ?'
  ).get(submissionId, req.userId!, emoji) as any;

  let toggled: 'added' | 'removed';

  if (existing) {
    db.prepare('DELETE FROM reactions WHERE id = ?').run(existing.id);
    toggled = 'removed';
  } else {
    db.prepare(
      'INSERT INTO reactions (id, submission_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(uuid(), submissionId, req.userId!, emoji, new Date().toISOString());
    toggled = 'added';

    // Send notification to submission owner (not self)
    if (submission.user_id !== req.userId!) {
      const user = db.prepare('SELECT name FROM users WHERE id = ?').get(req.userId!) as any;
      const pact = db.prepare('SELECT title FROM pacts WHERE id = ?').get(submission.pact_id) as any;
      const message = `${user.name} reacted ${emoji} to your submission in ${pact.title}`;
      const timestamp = new Date().toISOString();

      db.prepare(
        'INSERT INTO notifications (id, type, from_user_id, pact_id, user_id, message, timestamp, read) VALUES (?, ?, ?, ?, ?, ?, ?, 0)'
      ).run(uuid(), 'reaction', req.userId!, submission.pact_id, submission.user_id, message, timestamp);

      sendPushToUser(submission.user_id, {
        title: 'New Reaction',
        body: message,
        icon: '/icon-192x192.png',
        url: `/pact/${submission.pact_id}`,
        tag: `reaction-${submissionId}`,
      });
    }
  }

  const reactions = getReactionSummary(submissionId, req.userId!);

  // Broadcast via WebSocket to all pact members
  emitReactionUpdate(submission.pact_id, { submissionId, reactions });

  res.json({ toggled, reactions });
});

// Get reactions for a submission
router.get('/submissions/:submissionId/reactions', authMiddleware, (req: AuthRequest, res: Response) => {
  const { submissionId } = req.params;

  const submission = db.prepare('SELECT pact_id FROM submissions WHERE id = ?').get(submissionId) as any;
  if (!submission) {
    res.status(404).json({ error: 'Submission not found' });
    return;
  }

  const participant = db.prepare(
    `SELECT 1 FROM pact_participants WHERE pact_id = ? AND user_id = ? AND status = 'accepted'`
  ).get(submission.pact_id, req.userId!);
  if (!participant) {
    res.status(403).json({ error: 'You are not a participant of this pact' });
    return;
  }

  const reactions = getReactionSummary(submissionId, req.userId!);
  res.json(reactions);
});

export default router;
