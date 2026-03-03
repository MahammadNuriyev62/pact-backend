import { Router, Response } from 'express';
import bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';
import db from '../db';
import { AuthRequest, authMiddleware, signToken } from '../middleware/auth';

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
  const user = db.prepare('SELECT id, name, username, email, avatar FROM users WHERE id = ?').get(req.userId!) as any;
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  if (user.avatar && user.avatar.startsWith('/')) {
    user.avatar = `${baseUrl}${user.avatar}`;
  }
  res.json({ ...user, isCurrentUser: true });
});

export default router;
