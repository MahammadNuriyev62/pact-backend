import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import db from './db';

let io: Server | null = null;

export function initSocket(httpServer: HttpServer) {
  io = new Server(httpServer, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
  });

  // Auth middleware — verify JWT on connection
  io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('Authentication required'));

    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET!) as { userId: string };
      (socket as any).userId = payload.userId;
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket: Socket) => {
    const userId = (socket as any).userId as string;

    // Auto-join rooms for all pacts the user participates in
    const pacts = db.prepare(
      `SELECT pact_id FROM pact_participants WHERE user_id = ? AND status = 'accepted'`
    ).all(userId) as any[];

    for (const p of pacts) {
      socket.join(`pact:${p.pact_id}`);
    }

    // Allow client to join/leave specific pact rooms
    socket.on('join-pact', (pactId: string) => {
      socket.join(`pact:${pactId}`);
    });

    socket.on('leave-pact', (pactId: string) => {
      socket.leave(`pact:${pactId}`);
    });
  });

  return io;
}

/** Emit a new message to all users in a pact room */
export function emitNewMessage(pactId: string, message: any) {
  if (!io) return;
  io.to(`pact:${pactId}`).emit('new-message', message);
}

/** Emit updated reactions for a submission to all users in a pact room */
export function emitReactionUpdate(pactId: string, data: { submissionId: string; reactions: any[] }) {
  if (!io) return;
  io.to(`pact:${pactId}`).emit('reaction-update', data);
}
