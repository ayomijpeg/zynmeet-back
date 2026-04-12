import express, { Request, Response } from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import cookieParser from 'cookie-parser';
import { OAuth2Client } from 'google-auth-library';

// $500k Logic: Internal Service Imports
import { db } from './lib/db'; 
import { startBillingBlock } from './services/billing.service';

dotenv.config();

const app = express();
const httpServer = createServer(app);
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const JWT_SECRET = process.env.JWT_SECRET || 'zyn_ultra_secure_500k_pulse';
const isProd = process.env.NODE_ENV === 'production';

// --- PRODUCTION CORS ---
app.use(cors({
  origin: isProd ? "https://zynmeet-front.vercel.app" : "http://localhost:3000",
  credentials: true
}));

app.use(cookieParser() as any); 

// --- 1. PAYSTACK WEBHOOK (Must stay above express.json) ---
app.post('/api/v1/webhooks/paystack', 
  express.raw({ type: 'application/json' }), 
  async (req: Request, res: Response): Promise<void> => {
    const signature = req.headers['x-paystack-signature'] as string;
    const secret = process.env.PAYSTACK_WEBHOOK_SECRET || 'sk_test_placeholder';

    const hash = crypto.createHmac('sha512', secret).update(req.body).digest('hex');

    if (hash !== signature) {
      console.error("⚠️ HMAC Signature Mismatch");
      res.status(401).send('Unauthorized');
      return;
    }

    const payload = JSON.parse(req.body.toString());
    
    if (payload.event === 'charge.success') {
      const { amount, metadata, reference } = payload.data;
      const userId = metadata.user_id;

      try {
        await db.$transaction([
          // Fix Error TS2353: Mapping ledger correctly to latest schema
          db.walletLedger.create({
            data: { 
                userId, 
                amount, 
                type: 'CREDIT', 
                gateway: 'paystack', 
                eventId: reference 
            }
          }),
          db.walletBalance.upsert({
            where: { userId },
            update: { balance: { increment: amount } },
            create: { userId, balance: amount }
          })
        ]);
        io.to(`user:${userId}`).emit('billing:funded', { amount });
      } catch (e) {
        console.error("Financial Sync Failed:", e);
      }
    }
    res.sendStatus(200);
});

app.use(express.json());

// --- 2. AUTHENTICATION ---

app.post('/api/v1/auth/google', async (req: Request, res: Response) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ success: false });

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
        name: payload.name || "ZynDrx Member", 
        provider: "google"
      }
    });

    const jwtToken = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
    
    res.cookie('zyn_auth', jwtToken, { 
      httpOnly: true, 
      secure: isProd,
      sameSite: isProd ? 'none' : 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000 
    });

    res.json({ success: true, user });
  } catch (error) {
    res.status(401).json({ success: false });
  }
});

app.get('/api/v1/auth/me', async (req: Request, res: Response) => {
    const token = req.cookies.zyn_auth;
    if (!token) return res.json({ user: null });
    try {
        const decoded = jwt.verify(token, JWT_SECRET) as { userId: string };
        const user = await db.user.findUnique({
            where: { id: decoded.userId },
            select: { id: true, name: true, email: true, walletBalance: true }
        });
        res.json({ user });
    } catch {
        res.json({ user: null });
    }
});

// --- 3. VIDEO SIGNALING HUB ---

export const io = new Server(httpServer, {
  cors: { 
    origin: isProd ? "https://zynmeet-front.vercel.app" : "http://localhost:3000",
    credentials: true 
  } 
});

io.on('connection', (socket) => {
  console.log('📡 Connected Node:', socket.id);

  socket.on('request-join', async (data: { roomId: string, userId?: string, guestName?: string }) => {
    const { roomId, userId, guestName } = data;
    
    try {
      let finalName = guestName || "Guest Attendee";
      // Fix Error TS2304: Scoped correctly for billing initialization
      let hostToCharge = userId || "SYSTEM_ORPHAN";

      if (userId) {
         const user = await db.user.findUnique({ where: { id: userId } });
         if (user && user.name) finalName = user.name;
      }

      socket.join(roomId);
      socket.join(`user:${userId || socket.id}`);

      const room = await db.room.upsert({
        where: { slug: roomId },
        update: {},
        create: { slug: roomId, hostId: hostToCharge }
      });

      // TRIGGER 30-MIN ACCOUNTING
      await startBillingBlock(room.hostId, roomId);

      console.log(`✔️ [${roomId}] JOIN SUCCESS: ${finalName}`);
      socket.emit('joined-successfully', { displayName: finalName, roomId });
      socket.to(roomId).emit('participant-joined', { name: finalName, id: socket.id });

    } catch (error) {
      console.error('Socket Signaling Error:', error);
      socket.emit('join-error', { msg: 'Platform Syncing...' });
    }
  });

  socket.on('disconnect', () => console.log('❌ Device Disconnected'));
});

app.get('/health', (req, res) => res.send('OK'));

const PORT = process.env.PORT || 4000;
httpServer.listen(PORT, () => {
  console.log(`\n✅ ZYNDRX PRODUCTION STACK ACTIVE ON: ${PORT}\n`);
});
