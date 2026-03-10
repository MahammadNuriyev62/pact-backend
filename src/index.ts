import 'dotenv/config';
import { createServer } from 'http';
import { initDb } from './db';
import { seed } from './seed';
import { createApp } from './app';
import { migrateExistingImages } from './imageUtils';
import { initSocket } from './socket';
import { startScheduler } from './scheduler';
import path from 'path';

const app = createApp();
const httpServer = createServer(app);
const PORT = process.env.PORT || 3000;

// Initialize DB and seed
initDb();
seed();

// Compress existing unoptimized images (idempotent, skips small files)
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..');
migrateExistingImages(path.join(DATA_DIR, 'uploads'));

// Initialize WebSocket server
initSocket(httpServer);

// Start deadline reminder scheduler
startScheduler();

httpServer.listen(PORT, () => {
  console.log(`Pact backend running on http://localhost:${PORT}`);
});
