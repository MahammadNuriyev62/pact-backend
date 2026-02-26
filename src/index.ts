import 'dotenv/config';
import express from 'express';
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

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Ensure uploads directory exists
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..');
const uploadsDir = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

// Serve uploaded photos
app.use('/uploads', express.static(uploadsDir));

// Routes
app.use('/auth', authRoutes);
app.use('/users', usersRoutes);
app.use('/pacts', pactsRoutes);
app.use('/submissions', submissionsRoutes);
app.use('/streaks', streaksRoutes);
app.use('/notifications', notificationsRoutes);
app.use('/nudge', nudgeRoutes);

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Initialize DB and seed
initDb();
seed();

app.listen(PORT, () => {
  console.log(`Pact backend running on http://localhost:${PORT}`);
});
