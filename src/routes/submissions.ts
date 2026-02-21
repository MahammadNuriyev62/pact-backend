import { Router, Response } from 'express';
import { v4 as uuid } from 'uuid';
import multer from 'multer';
import path from 'path';
import db from '../db';
import { AuthRequest, authMiddleware } from '../middleware/auth';

const storage = multer.diskStorage({
  destination: path.join(__dirname, '..', '..', 'uploads'),
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

  // Verify user is a participant
  const participant = db.prepare('SELECT 1 FROM pact_participants WHERE pact_id = ? AND user_id = ?').get(pactId, req.userId!);
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

  // Create notification for other participants
  const otherParticipants = db.prepare(
    'SELECT user_id FROM pact_participants WHERE pact_id = ? AND user_id != ?'
  ).all(pactId, req.userId!) as any[];

  const user = db.prepare('SELECT name FROM users WHERE id = ?').get(req.userId!) as any;
  const pact = db.prepare('SELECT title FROM pacts WHERE id = ?').get(pactId) as any;

  const insertNotif = db.prepare(`
    INSERT INTO notifications (id, type, from_user_id, pact_id, user_id, message, timestamp, read)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0)
  `);

  for (const p of otherParticipants) {
    insertNotif.run(
      uuid(),
      'new_submission',
      req.userId!,
      pactId,
      p.user_id,
      `${user.name} just submitted for ${pact.title}!`,
      timestamp,
    );
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
    JOIN pact_participants pp ON pp.pact_id = s.pact_id AND pp.user_id = ?
    ORDER BY s.timestamp DESC
    LIMIT 10
  `).all(req.userId!) as any[];

  res.json(subs.map(s => ({
    id: s.id,
    pactId: s.pact_id,
    userId: s.user_id,
    photoUri: s.photo_uri,
    timestamp: s.timestamp,
    verified: !!s.verified,
    user: { id: s.user_id, name: s.user_name, username: s.username, avatar: s.user_avatar },
    pact: { id: s.pact_id, title: s.pact_title, icon: s.pact_icon, iconFamily: s.pact_icon_family, color: s.pact_color },
  })));
});

export default router;
