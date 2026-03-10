import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import authRoutes from './routes/auth';
import usersRoutes from './routes/users';
import pactsRoutes from './routes/pacts';
import submissionsRoutes from './routes/submissions';
import streaksRoutes from './routes/streaks';
import notificationsRoutes from './routes/notifications';
import nudgeRoutes from './routes/nudge';
import pushRoutes from './routes/push';
import reactionsRoutes from './routes/reactions';
import messagesRoutes from './routes/messages';

export function createApp() {
  const app = express();

  app.set('trust proxy', true);
  app.use(cors());
  app.use(express.json());

  const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..');
  const uploadsDir = path.join(DATA_DIR, 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });
  app.use('/uploads', express.static(uploadsDir, { maxAge: '7d' }));

  app.use('/auth', authRoutes);
  app.use('/users', usersRoutes);
  app.use('/pacts', pactsRoutes);
  app.use('/submissions', submissionsRoutes);
  app.use('/streaks', streaksRoutes);
  app.use('/notifications', notificationsRoutes);
  app.use('/nudge', nudgeRoutes);
  app.use('/push', pushRoutes);
  app.use('/reactions', reactionsRoutes);
  app.use('/pacts', messagesRoutes);

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  return app;
}
