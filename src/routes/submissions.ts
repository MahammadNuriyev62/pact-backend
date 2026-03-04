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

const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `${uuid()}${ext}`);
  },
});

const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

const router = Router();

// Create a submission (always verified)
router.post('/', authMiddleware, upload.single('photo'), (req: AuthRequest, res: Response) => {
  const { pactId } = req.body;
  if (!pactId) {
    res.status(400).json({ error: 'pactId is required' });
    return;
  }

  // Verify user is an accepted participant
  const participant = db.prepare(`SELECT 1 FROM pact_participants WHERE pact_id = ? AND user_id = ? AND status = 'accepted'`).get(pactId, req.userId!);
  if (!participant) {
    res.status(403).json({ error: 'You are not a participant of this pact' });
    return;
  }

  const id = uuid();
  const timestamp = new Date().toISOString();
  let photoUri: string;

  if (req.file) {
    photoUri = `/uploads/${req.file.filename}`;
  } else if (req.body.photoUri) {
    // Allow passing a URL directly (for web/external images)
    photoUri = req.body.photoUri;
  } else {
    res.status(400).json({ error: 'photo file or photoUri is required' });
    return;
  }

  // Always verified - no AI analysis
  db.prepare(`
    INSERT INTO submissions (id, pact_id, user_id, photo_uri, timestamp, verified)
    VALUES (?, ?, ?, ?, ?, 1)
  `).run(id, pactId, req.userId!, photoUri, timestamp);

  // Create notification for other accepted participants
  const otherParticipants = db.prepare(
    `SELECT user_id FROM pact_participants WHERE pact_id = ? AND user_id != ? AND status = 'accepted'`
  ).all(pactId, req.userId!) as any[];

  const user = db.prepare('SELECT name FROM users WHERE id = ?').get(req.userId!) as any;
  const pact = db.prepare('SELECT title FROM pacts WHERE id = ?').get(pactId) as any;

  const insertNotif = db.prepare(`
    INSERT INTO notifications (id, type, from_user_id, pact_id, user_id, message, timestamp, read)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0)
  `);

  for (const p of otherParticipants) {
    const message = `${user.name} just submitted for ${pact.title}!`;
    insertNotif.run(uuid(), 'new_submission', req.userId!, pactId, p.user_id, message, timestamp);
    sendPushToUser(p.user_id, {
      title: 'New Submission',
      body: message,
      icon: '/icon-192x192.png',
      url: '/notifications',
      tag: `submission-${pactId}`,
    });
  }

  res.status(201).json({
    id,
    pactId,
    userId: req.userId!,
    photoUri,
    timestamp,
    verified: true,
    matched: true,
  });
});

// Get recent activity across all pacts for current user
router.get('/recent', authMiddleware, (req: AuthRequest, res: Response) => {
  const subs = db.prepare(`
    SELECT s.*, u.name as user_name, u.username, u.avatar as user_avatar,
           p.title as pact_title, p.icon as pact_icon, p.icon_family as pact_icon_family, p.color as pact_color
    FROM submissions s
    JOIN users u ON u.id = s.user_id
    JOIN pacts p ON p.id = s.pact_id
    JOIN pact_participants pp ON pp.pact_id = s.pact_id AND pp.user_id = ? AND pp.status = 'accepted'
    ORDER BY s.timestamp DESC
    LIMIT 10
  `).all(req.userId!) as any[];

  const baseUrl = `${req.protocol}://${req.get('host')}`;
  res.json(subs.map(s => ({
    id: s.id,
    pactId: s.pact_id,
    userId: s.user_id,
    photoUri: s.photo_uri.startsWith('/') ? `${baseUrl}${s.photo_uri}` : s.photo_uri,
    timestamp: s.timestamp,
    verified: !!s.verified,
    user: { id: s.user_id, name: s.user_name, username: s.username, avatar: fullAvatarUrl(s.user_avatar, req) },
    pact: { id: s.pact_id, title: s.pact_title, icon: s.pact_icon, iconFamily: s.pact_icon_family, color: s.pact_color },
  })));
});

export default router;
