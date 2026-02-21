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
  res.json({ ...user, isCurrentUser: true });
});

export default router;
