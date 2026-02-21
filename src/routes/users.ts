import { Router, Response } from 'express';
import db from '../db';
import { AuthRequest, authMiddleware } from '../middleware/auth';

const router = Router();

router.get('/', authMiddleware, (req: AuthRequest, res: Response) => {
  const users = db.prepare('SELECT id, name, username, avatar FROM users WHERE id != ?').all(req.userId!) as any[];
  res.json(users);
});

export default router;
