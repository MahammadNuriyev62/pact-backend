import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { initDb } from './db';
import { seed } from './seed';
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
import { migrateExistingImages } from './imageUtils';
import { initSocket } from './socket';
import { startScheduler } from './scheduler';

const app = express();
const httpServer = createServer(app);
const PORT = process.env.PORT || 3000;

// Middleware
app.set('trust proxy', true);
app.use(cors());
app.use(express.json());

// Ensure uploads directory exists
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..');
const uploadsDir = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

// Serve uploaded photos (7d cache — filenames include UUIDs so they're unique)
app.use('/uploads', express.static(uploadsDir, { maxAge: '7d' }));

// Routes
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

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Initialize DB and seed
initDb();
seed();

// Compress existing unoptimized images (idempotent, skips small files)
migrateExistingImages(uploadsDir);

// Initialize WebSocket server
initSocket(httpServer);

// Start deadline reminder scheduler
startScheduler();

httpServer.listen(PORT, () => {
  console.log(`Pact backend running on http://localhost:${PORT}`);
});
