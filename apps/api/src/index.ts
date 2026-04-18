import express, { Request, Response } from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import cookieParser from 'cookie-parser';
import { OAuth2Client } from 'google-auth-library';

// Core Service Imports
import { db } from './lib/db'; 
import { startBillingBlock } from './services/billing.service';

dotenv.config();

const app = express();
const httpServer = createServer(app);
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const JWT_SECRET = process.env.JWT_SECRET || 'zyn_ultra_secure_500k_pulse';
const isProd = process.env.NODE_ENV === 'production';

// --- FIXED DYNAMIC CORS HANDLER ---
const allowedOrigins = [
  "http://localhost:3000",
  "https://zynmeet-front.vercel.app"
];

app.use(cors({
  origin: (origin, callback) => {
    // Allow server-to-server or local dev without origin
    if (!origin || !isProd) return callback(null, true);
    
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('CORS blocked by ZynMeet Security Policy'));
    }
  },
  credentials: true,
  methods: ["GET", "POST", "OPTIONS"]
}));

app.use(cookieParser() as any); 

// --- INITIALIZE SOCKET.IO (SINGLE INSTANCE) ---
export const io = new Server(httpServer, {
  cors: { 
    origin: allowedOrigins,
    credentials: true 
  } 
});

// --- 1. WEBHOOKS (RAW Body required) ---
app.post('/api/v1/webhooks/paystack', 
  express.raw({ type: 'application/json' }), 
  async (req: Request, res: Response): Promise<void> => {
    const signature = req.headers['x-paystack-signature'] as string;
    const secret = process.env.PAYSTACK_WEBHOOK_SECRET || 'sk_test_placeholder';
    const hash = crypto.createHmac('sha512', secret).update(req.body).digest('hex');

    if (hash !== signature) {
      res.status(401).send('Unauthorized');
      return;
    }

    const payload = JSON.parse(req.body.toString());
    if (payload.event === 'charge.success') {
      const { amount, metadata, reference } = payload.data;
      try {
        await db.$transaction([
          db.walletLedger.create({
            data: { userId: metadata.user_id, amount, type: 'CREDIT', gateway: 'paystack', eventId: reference }
          }),
          db.walletBalance.upsert({
            where: { userId: metadata.user_id },
            update: { balance: { increment: amount } },
            create: { userId: metadata.user_id, balance: amount }
          })
        ]);
        io.to(`user:${metadata.user_id}`).emit('billing:funded', { amount });
      } catch (e) { console.error("Ledger Failure", e); }
    }
    res.sendStatus(200);
});

app.use(express.json());

// --- 2. AUTHENTICATION ---
app.post('/api/v1/auth/google', async (req: Request, res: Response) => {
  const { token } = req.body;
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    if (!payload?.email) return res.status(401).json({ success: false });

    const user = await db.user.upsert({
      where: { email: payload.email },
      update: { name: payload.name || "Member" },
      create: { 
        email: payload.email, 
        name: payload.name || "Member", 
        provider: "google"
      }
    });

    const jwtToken = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
    
    // Set cookie for Production (SameSite: None required for Vercel -> Render)
    res.cookie('zyn_auth', jwtToken, { 
      httpOnly: true, 
      secure: true, 
      sameSite: 'none', 
      maxAge: 7 * 24 * 60 * 60 * 1000 
    });

    res.json({ success: true, user });
  } catch (error) { res.status(401).json({ success: false }); }
});

app.get('/api/v1/auth/me', async (req: Request, res: Response) => {
    const token = req.cookies.zyn_auth;
    if (!token) return res.json({ user: null });
    try {
        const decoded = jwt.verify(token, JWT_SECRET) as { userId: string };
        const user = await db.user.findUnique({
            where: { id: decoded.userId },
            include: { walletRecord: true }
        });
        res.json({ user });
    } catch { res.json({ user: null }); }
});

// --- 3. SIGNALING HUB ---
io.on('connection', (socket) => {
  socket.on('request-join', async (data: { roomId: string, userId?: string, displayName?: string }) => {
    const { roomId, userId, displayName } = data;
    
    try {
      let finalName = displayName || "Guest";
      let actualUserId = userId || "GUEST_" + socket.id;

      if (userId) {
         const user = await db.user.findUnique({ where: { id: userId } });
         if (user && user.name) finalName = user.name;
      }

      socket.join(roomId);
      socket.join(`user:${actualUserId}`);
      
      socket.data.roomId = roomId;
      socket.data.userName = finalName;
      socket.data.userId = actualUserId;

      const room = await db.room.upsert({
        where: { slug: roomId },
        update: {},
        create: { slug: roomId, hostId: userId || "SYSTEM" }
      });

      await startBillingBlock(room.hostId, roomId);

      // Notify users
      const participants = await io.in(roomId).fetchSockets();
      const peerList = participants
        .filter(s => s.id !== socket.id)
        .map(s => ({ id: s.id, name: s.data.userName }));
      
      socket.emit('room:participant_list', peerList);
      socket.to(roomId).emit('participant:joined', { id: socket.id, name: finalName });

      socket.emit('joined-successfully', { displayName: finalName, roomId });
    } catch (e) {
      socket.emit('join-error', { msg: 'Platform sync error' });
    }
  });

  socket.on('disconnect', () => {
     if (socket.data.roomId) {
        socket.to(socket.data.roomId).emit('participant:left', socket.id);
     }
  });
});

app.get('/health', (req: Request, res: Response) => res.json({ status: "Active" }));

const PORT = process.env.PORT || 4000;
httpServer.listen(PORT, () => {
  console.log(`\n✅ PRODUCTION INFRASTRUCTURE FULLY SYNCED ON: ${PORT}\n`);
});
