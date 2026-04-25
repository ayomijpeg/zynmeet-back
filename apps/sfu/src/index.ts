import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import * as mediasoup from 'mediasoup';
import os from 'os';
import dotenv from 'dotenv';

dotenv.config();

type Worker = mediasoup.types.Worker;
type Router = mediasoup.types.Router;
type RtpCodecCapability = mediasoup.types.RtpCodecCapability;
type WebRtcTransport = mediasoup.types.WebRtcTransport;
type Producer = mediasoup.types.Producer;
type Consumer = mediasoup.types.Consumer;

const app = express();
const httpServer = createServer(app);

// FIX: Allow all origins — SFU uses no cookies/credentials so wildcard is safe.
// Restricting by origin was causing 400 errors on the Vercel → Fly.io connection.
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: false,
  },
  // FIX: Force WebSocket transport only — avoids polling 400 errors on Fly.io
  // which doesn't support long-polling well behind its HTTP proxy.
  transports: ['websocket'],
});

// --- GLOBAL STATE ---
let workers: Worker[] = [];
let nextWorkerIdx = 0;
const rooms      = new Map<string, Router>();
const transports = new Map<string, WebRtcTransport>();
const producers  = new Map<string, Producer>();
const consumers  = new Map<string, Consumer>();

interface RoomProducerEntry {
  producerId: string;
  socketId: string;
  kind: 'audio' | 'video';
}
const roomProducers = new Map<string, RoomProducerEntry[]>();

const mediaCodecs: RtpCodecCapability[] = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
    preferredPayloadType: 111,
    rtcpFeedback: [{ type: 'transport-cc' }],
  },
  {
    kind: 'video',
    mimeType: 'video/VP9',
    clockRate: 90000,
    preferredPayloadType: 100,
    parameters: { 'profile-id': 2, 'x-google-start-bitrate': 1000 },
    rtcpFeedback: [
      { type: 'nack' },
      { type: 'nack', parameter: 'pli' },
      { type: 'ccm', parameter: 'fir' },
      { type: 'goog-remb' },
      { type: 'transport-cc' },
    ],
  },
  {
    kind: 'video',
    mimeType: 'video/h264',
    clockRate: 90000,
    preferredPayloadType: 102,
    parameters: {
      'packetization-mode': 1,
      'profile-level-id': '42e01f',
      'level-asymmetry-allowed': 1,
      'x-google-start-bitrate': 1000,
    },
    rtcpFeedback: [
      { type: 'nack' },
      { type: 'nack', parameter: 'pli' },
      { type: 'ccm', parameter: 'fir' },
      { type: 'goog-remb' },
      { type: 'transport-cc' },
    ],
  },
];

async function createWorkers() {
  const numWorkers = process.env.NODE_ENV === 'production' ? os.cpus().length : 1;
  console.log(`[SFU] Spawning ${numWorkers} Mediasoup workers...`);

  for (let i = 0; i < numWorkers; i++) {
    const worker = await mediasoup.createWorker({
      logLevel: 'warn',
      rtcMinPort: parseInt(process.env.MIN_PORT || '10000', 10),
      rtcMaxPort: parseInt(process.env.MAX_PORT || '10100', 10),
    });

    worker.on('died', () => {
      console.error(`[SFU] Mediasoup worker ${worker.pid} died, exiting...`);
      setTimeout(() => process.exit(1), 2000);
    });

    workers.push(worker);
  }
}

function getNextWorker(): Worker {
  const worker = workers[nextWorkerIdx];
  nextWorkerIdx = (nextWorkerIdx + 1) % workers.length;
  return worker;
}

async function getOrCreateRouter(roomId: string): Promise<Router> {
  let router = rooms.get(roomId);
  if (!router) {
    const worker = getNextWorker();
    router = await worker.createRouter({ mediaCodecs });
    rooms.set(roomId, router);
    console.log(`[SFU] Created new router for room: ${roomId}`);
  }
  return router;
}

function cleanupSocket(socketId: string, roomId?: string) {
  if (roomId) {
    const list    = roomProducers.get(roomId) || [];
    const updated = list.filter((p) => p.socketId !== socketId);
    if (updated.length > 0) roomProducers.set(roomId, updated);
    else roomProducers.delete(roomId);
  }

  for (const [id, producer] of producers.entries()) {
    if ((producer.appData as any)?.socketId === socketId) {
      producer.close();
      producers.delete(id);
    }
  }

  for (const [id, consumer] of consumers.entries()) {
    if ((consumer.appData as any)?.socketId === socketId) {
      consumer.close();
      consumers.delete(id);
    }
  }

  for (const [id, transport] of transports.entries()) {
    if ((transport.appData as any)?.socketId === socketId) {
      transport.close();
      transports.delete(id);
    }
  }
}

// --- SIGNALING ---
io.on('connection', (socket) => {
  console.log(`[SFU Signaling] Peer connected: ${socket.id}`);

  socket.on('join-sfu-room', ({ roomId }: { roomId: string }) => {
    socket.join(roomId);
    socket.data.roomId = roomId;
    console.log(`[SFU] Socket ${socket.id} joined media room ${roomId}`);
  });

  socket.on('getRouterRtpCapabilities', async ({ roomId }: { roomId: string }, callback: Function) => {
    try {
      const router = await getOrCreateRouter(roomId);
      callback(router.rtpCapabilities);
    } catch (error: any) {
      callback({ error: error.message });
    }
  });

  socket.on('createWebRtcTransport', async ({ roomId }: { roomId: string }, callback: Function) => {
    try {
      const router    = await getOrCreateRouter(roomId);
      const transport = await router.createWebRtcTransport({
        listenIps: [{
          ip:          process.env.MEDIASOUP_LISTEN_IP    || '0.0.0.0',
          announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP || '127.0.0.1',
        }],
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
        appData: { socketId: socket.id },
      });

      transports.set(transport.id, transport);

      callback({
        id:             transport.id,
        iceParameters:  transport.iceParameters,
        iceCandidates:  transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
      });
    } catch (error: any) {
      callback({ error: error.message });
    }
  });

  socket.on('connectTransport', async ({ transportId, dtlsParameters }: any, callback: Function) => {
    try {
      const transport = transports.get(transportId);
      if (!transport) throw new Error(`Transport ${transportId} not found`);
      await transport.connect({ dtlsParameters });
      callback({ success: true });
    } catch (error: any) {
      callback({ error: error.message });
    }
  });

  socket.on('produce', async ({ transportId, kind, rtpParameters, appData }: any, callback: Function) => {
    try {
      const transport = transports.get(transportId);
      if (!transport) throw new Error(`Transport ${transportId} not found`);

      const producer = await transport.produce({
        kind,
        rtpParameters,
        appData: { ...appData, socketId: socket.id },
      });

      producers.set(producer.id, producer);

      if (socket.data.roomId) {
        const list = roomProducers.get(socket.data.roomId) || [];
        list.push({ producerId: producer.id, socketId: socket.id, kind });
        roomProducers.set(socket.data.roomId, list);

        socket.broadcast.to(socket.data.roomId).emit('newProducer', {
          producerId: producer.id,
          socketId:   socket.id,
          kind,
        });
      }

      callback({ id: producer.id });
    } catch (error: any) {
      callback({ error: error.message });
    }
  });

  socket.on('getExistingProducers', ({ roomId }: { roomId: string }, callback: Function) => {
    try {
      const existing = roomProducers.get(roomId) || [];
      const others   = existing.filter((p) => p.socketId !== socket.id);
      console.log(`[SFU] Sending ${others.length} existing producer(s) to ${socket.id}`);
      callback(others);
    } catch {
      callback([]);
    }
  });

  socket.on('consume', async ({ transportId, producerId, rtpCapabilities }: any, callback: Function) => {
    try {
      const router    = rooms.get(socket.data.roomId);
      const transport = transports.get(transportId);

      if (!router || !transport) throw new Error('Router or Transport not found');
      if (!router.canConsume({ producerId, rtpCapabilities })) {
        throw new Error(`Cannot consume producerId=${producerId}`);
      }

      const consumer = await transport.consume({
        producerId,
        rtpCapabilities,
        paused:  true,
        appData: { socketId: socket.id },
      });

      consumers.set(consumer.id, consumer);

      callback({
        id:            consumer.id,
        producerId,
        kind:          consumer.kind,
        rtpParameters: consumer.rtpParameters,
      });
    } catch (error: any) {
      callback({ error: error.message });
    }
  });

  socket.on('resume', async ({ consumerId }: { consumerId: string }, callback: Function) => {
    try {
      const consumer = consumers.get(consumerId);
      if (!consumer) throw new Error(`Consumer ${consumerId} not found`);
      await consumer.resume();
      callback({ success: true });
    } catch (error: any) {
      callback({ error: error.message });
    }
  });

  socket.on('disconnect', () => {
    console.log(`[SFU Signaling] Peer disconnected: ${socket.id}`);
    const roomId = socket.data.roomId;
    cleanupSocket(socket.id, roomId);
    if (roomId) {
      socket.broadcast.to(roomId).emit('peerDisconnected', { socketId: socket.id });
    }
  });
});

// Also update the client to use websocket transport only
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

app.get('/health', (req, res) => res.json({ status: 'Active', service: 'ZynMeet SFU' }));

const PORT = process.env.SFU_PORT || process.env.PORT || 8080;

async function bootstrap() {
  await createWorkers();
  httpServer.listen(PORT, () => {
    console.log(`[SFU] Mediasoup Signaling Server running on port ${PORT}`);
  });
}

bootstrap().catch((err) => {
  console.error('[SFU] Boot error:', err);
});
