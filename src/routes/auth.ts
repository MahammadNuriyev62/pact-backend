import { Router, Response } from 'express';
import bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';
import fs from 'fs';
import path from 'path';
import db from '../db';
import { AuthRequest, authMiddleware, signToken } from '../middleware/auth';
import { fullAvatarUrl } from '../utils';

const router = Router();

router.post('/register', (req: AuthRequest, res: Response) => {
  const { name, username, email, password } = req.body;
  if (!name || !username || !email || !password) {
    res.status(400).json({ error: 'name, username, email, and password are required' });
    return;
  }

  const existing = db.prepare('SELECT id FROM users WHERE email = ? OR username = ?').get(email, username);
  if (existing) {
    res.status(409).json({ error: 'Email or username already taken' });
    return;
  }

  const id = uuid();
  const passwordHash = bcrypt.hashSync(password, 10);
  const avatar = `https://i.pravatar.cc/150?u=${id}`;

  db.prepare('INSERT INTO users (id, name, username, email, password_hash, avatar) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, name, username, email, passwordHash, avatar);

  const token = signToken(id);
  res.status(201).json({
    token,
    user: { id, name, username, email, avatar, isCurrentUser: true },
  });
});

router.post('/login', (req: AuthRequest, res: Response) => {
  const { email, password } = req.body;
  if (!email || !password) {
    res.status(400).json({ error: 'email and password are required' });
    return;
  }

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as any;
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    res.status(401).json({ error: 'Invalid email or password' });
    return;
  }

  const token = signToken(user.id);
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const avatar = user.avatar?.startsWith('/') ? `${baseUrl}${user.avatar}` : user.avatar;
  res.json({
    token,
    user: {
      id: user.id,
      name: user.name,
      username: user.username,
      email: user.email,
      avatar,
      isCurrentUser: true,
    },
  });
});

function generateUniqueUsername(email: string): string {
  let base = email.split('@')[0]
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '')
    .substring(0, 20);
  if (!base) base = 'user';

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(base);
  if (!existing) return base;

  for (let i = 0; i < 100; i++) {
    const suffix = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
    const candidate = `${base}${suffix}`;
    if (!db.prepare('SELECT id FROM users WHERE username = ?').get(candidate)) return candidate;
  }
  return `user_${uuid().substring(0, 8)}`;
}

router.post('/google', async (req: AuthRequest, res: Response) => {
  const { accessToken } = req.body;
  if (!accessToken) {
    res.status(400).json({ error: 'accessToken is required' });
    return;
  }

  let googleUser: { sub: string; email: string; name: string; picture: string };
  try {
    const userInfoRes = await fetch(
      'https://www.googleapis.com/oauth2/v3/userinfo',
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!userInfoRes.ok) {
      res.status(401).json({ error: 'Invalid Google access token' });
      return;
    }
    const payload = await userInfoRes.json();

    if (!payload.sub || !payload.email) {
      res.status(401).json({ error: 'Incomplete Google profile' });
      return;
    }

    googleUser = {
      sub: payload.sub,
      email: payload.email,
      name: payload.name || payload.email.split('@')[0],
      picture: payload.picture || '',
    };
  } catch {
    res.status(401).json({ error: 'Failed to verify Google token' });
    return;
  }

  // Check if user with this google_id already exists
  let user = db.prepare('SELECT * FROM users WHERE google_id = ?').get(googleUser.sub) as any;

  if (!user) {
    // Check if user with this email exists (link accounts)
    user = db.prepare('SELECT * FROM users WHERE email = ?').get(googleUser.email) as any;

    if (user) {
      db.prepare('UPDATE users SET google_id = ? WHERE id = ?').run(googleUser.sub, user.id);
      if (!user.avatar && googleUser.picture) {
        db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(googleUser.picture, user.id);
      }
    } else {
      // Create new user
      const id = uuid();
      const username = generateUniqueUsername(googleUser.email);
      const placeholderHash = bcrypt.hashSync(uuid(), 10);
      const avatar = googleUser.picture || `https://i.pravatar.cc/150?u=${id}`;

      db.prepare(
        'INSERT INTO users (id, name, username, email, password_hash, avatar, google_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(id, googleUser.name, username, googleUser.email, placeholderHash, avatar, googleUser.sub);

      user = { id, name: googleUser.name, username, email: googleUser.email, avatar };
    }
  }

  const token = signToken(user.id);
  res.json({
    token,
    user: {
      id: user.id,
      name: user.name,
      username: user.username,
      email: user.email,
      avatar: user.avatar,
      isCurrentUser: true,
    },
  });
});

router.get('/me', authMiddleware, (req: AuthRequest, res: Response) => {
  const user = db.prepare('SELECT id, name, username, email, avatar, bio FROM users WHERE id = ?').get(req.userId!) as any;
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  res.json({ ...user, avatar: fullAvatarUrl(user.avatar, req), isCurrentUser: true });
});

// PUT /auth/profile — update profile fields
router.put('/profile', authMiddleware, (req: AuthRequest, res: Response) => {
  const { name, username, bio } = req.body;

  if (name === undefined && username === undefined && bio === undefined) {
    res.status(400).json({ error: 'At least one field (name, username, bio) is required' });
    return;
  }

  const updates: string[] = [];
  const values: any[] = [];

  if (name !== undefined) {
    const trimmed = String(name).trim();
    if (!trimmed || trimmed.length > 50) {
      res.status(400).json({ error: 'Name must be 1-50 characters', field: 'name' });
      return;
    }
    updates.push('name = ?');
    values.push(trimmed);
  }

  if (username !== undefined) {
    const trimmed = String(username).trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,30}$/.test(trimmed)) {
      res.status(400).json({ error: 'Username must be 3-30 characters (lowercase letters, numbers, dots, underscores, hyphens)', field: 'username' });
      return;
    }
    const existing = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(trimmed, req.userId!) as any;
    if (existing) {
      res.status(409).json({ error: 'Username is already taken', field: 'username' });
      return;
    }
    updates.push('username = ?');
    values.push(trimmed);
  }

  if (bio !== undefined) {
    const trimmed = String(bio).trim();
    if (trimmed.length > 160) {
      res.status(400).json({ error: 'Bio must be 160 characters or less', field: 'bio' });
      return;
    }
    updates.push('bio = ?');
    values.push(trimmed);
  }

  values.push(req.userId!);
  db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...values);

  const updated = db.prepare('SELECT id, name, username, email, avatar, bio FROM users WHERE id = ?').get(req.userId!) as any;
  res.json({ ...updated, avatar: fullAvatarUrl(updated.avatar, req), isCurrentUser: true });
});

// DELETE /auth/account — permanently delete account and all related data
router.delete('/account', authMiddleware, (req: AuthRequest, res: Response) => {
  const userId = req.userId!;
  const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..');
  const uploadsDir = path.join(DATA_DIR, 'uploads');

  // Collect files to delete (submissions + avatar)
  const userSubs = db.prepare('SELECT photo_uri FROM submissions WHERE user_id = ?').all(userId) as any[];
  const userRow = db.prepare('SELECT avatar FROM users WHERE id = ?').get(userId) as any;
  const filesToDelete: string[] = [];
  for (const s of userSubs) {
    if (s.photo_uri && s.photo_uri.startsWith('/uploads/')) {
      filesToDelete.push(path.join(uploadsDir, path.basename(s.photo_uri)));
    }
  }
  if (userRow?.avatar && userRow.avatar.startsWith('/uploads/')) {
    filesToDelete.push(path.join(uploadsDir, path.basename(userRow.avatar)));
  }

  // Run deletion in a transaction
  const deleteAll = db.transaction(() => {
    // 1. Delete reactions by this user
    db.prepare('DELETE FROM reactions WHERE user_id = ?').run(userId);

    // 2. Delete messages by this user
    db.prepare('DELETE FROM messages WHERE user_id = ?').run(userId);

    // 3. Delete streak freezes for this user
    db.prepare('DELETE FROM streak_freezes WHERE user_id = ?').run(userId);

    // 4. Delete notifications received or sent by this user
    db.prepare('DELETE FROM notifications WHERE user_id = ?').run(userId);
    db.prepare('UPDATE notifications SET from_user_id = NULL WHERE from_user_id = ?').run(userId);

    // 5. Delete push subscriptions
    db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(userId);

    // 6. Delete friendships
    db.prepare('DELETE FROM friendships WHERE requester_id = ? OR addressee_id = ?').run(userId, userId);

    // 7. Handle pacts where user is creator
    const createdPacts = db.prepare('SELECT id FROM pacts WHERE created_by = ?').all(userId) as any[];
    for (const pact of createdPacts) {
      // Find another accepted participant to transfer ownership
      const newOwner = db.prepare(
        `SELECT user_id FROM pact_participants WHERE pact_id = ? AND user_id != ? AND status = 'accepted' ORDER BY rowid ASC LIMIT 1`
      ).get(pact.id, userId) as any;

      if (newOwner) {
        db.prepare('UPDATE pacts SET created_by = ? WHERE id = ?').run(newOwner.user_id, pact.id);
      } else {
        // No other participants — delete the pact (CASCADE handles submissions, participants, etc.)
        db.prepare('DELETE FROM pacts WHERE id = ?').run(pact.id);
      }
    }

    // 8. Delete pact_participants entries (for pacts user didn't create)
    db.prepare('DELETE FROM pact_participants WHERE user_id = ?').run(userId);

    // 9. Delete submissions by this user (reactions on these cascade)
    db.prepare('DELETE FROM submissions WHERE user_id = ?').run(userId);

    // 10. Delete the user
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  });

  deleteAll();

  // Clean up files (non-critical, after transaction)
  for (const filePath of filesToDelete) {
    try { fs.unlinkSync(filePath); } catch { /* file may not exist */ }
  }

  res.json({ success: true });
});

export default router;
