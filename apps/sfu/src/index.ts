import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import * as mediasoup from 'mediasoup';
import os from 'os';
import dotenv from 'dotenv';

dotenv.config();

// Extract Mediasoup types safely
type Worker = mediasoup.types.Worker;
type Router = mediasoup.types.Router;
type RtpCodecCapability = mediasoup.types.RtpCodecCapability;
type WebRtcTransport = mediasoup.types.WebRtcTransport;
type Producer = mediasoup.types.Producer;
type Consumer = mediasoup.types.Consumer;

const app = express();
const httpServer = createServer(app);

// Socket.io Signaling Server Setup
const io = new Server(httpServer, {
  cors: {
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'POST'],
    credentials: true
  },
});

// --- GLOBAL STATE MANAGEMENT ---
let workers: Worker[] = [];
let nextWorkerIdx = 0;
const rooms = new Map<string, Router>();
const transports = new Map<string, WebRtcTransport>();
const producers = new Map<string, Producer>();
const consumers = new Map<string, Consumer>();

// ZynMeet MVP Codec Configuration (H.264 for iOS, VP9 for Chrome, 48kHz Opus)
const mediaCodecs: RtpCodecCapability[] = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
    preferredPayloadType: 111,
    rtcpFeedback: [{ type: 'transport-cc' }]
  },
  {
    kind: 'video',
    mimeType: 'video/VP9',
    clockRate: 90000,
    preferredPayloadType: 100,
    parameters: {
      'profile-id': 2,
      'x-google-start-bitrate': 1000,
    },
    rtcpFeedback: [
      { type: 'nack' },
      { type: 'nack', parameter: 'pli' },
      { type: 'ccm', parameter: 'fir' },
      { type: 'goog-remb' },
      { type: 'transport-cc' }
    ]
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
      { type: 'transport-cc' }
    ]
  },
];

// Initialize Mediasoup C++ Workers
async function createWorkers() {
  const numWorkers = process.env.NODE_ENV === 'production' ? os.cpus().length : 1; 
  console.log(`[SFU] Spawning ${numWorkers} Mediasoup workers...`);

  for (let i = 0; i < numWorkers; i++) {
    const worker = await mediasoup.createWorker({
      logLevel: 'warn',
      rtcMinPort: parseInt(process.env.MIN_PORT || '10000', 10),
      rtcMaxPort: parseInt(process.env.MAX_PORT || '59999', 10),
    });

    worker.on('died', () => {
      console.error(`[SFU] Mediasoup worker ${worker.pid} died, exiting...`);
      setTimeout(() => process.exit(1), 2000);
    });

    workers.push(worker);
  }
}

// Simple Round-Robin worker selection
function getNextWorker(): Worker {
  const worker = workers[nextWorkerIdx];
  nextWorkerIdx = (nextWorkerIdx + 1) % workers.length;
  return worker;
}

// Helper: Get or Create a Room Router
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

// --- MEDIASOUP SIGNALING PIPELINE ---
io.on('connection', (socket) => {
  console.log(`[SFU Signaling] Peer connected: ${socket.id}`);

  // 0. Join SFU Room (Allows broadcasting to peers in the same meeting)
  socket.on('join-sfu-room', ({ roomId }) => {
    socket.join(roomId);
    socket.data.roomId = roomId;
    console.log(`[SFU] Socket ${socket.id} joined media room ${roomId}`);
  });

  // 1. Send Router Capabilities
  socket.on('getRouterRtpCapabilities', async ({ roomId }, callback) => {
    try {
      const router = await getOrCreateRouter(roomId);
      callback(router.rtpCapabilities);
    } catch (error: any) {
      callback({ error: error.message });
    }
  });

  // 2. Create WebRTC Transport
  socket.on('createWebRtcTransport', async ({ roomId }, callback) => {
    try {
      const router = await getOrCreateRouter(roomId);
      
      const transport = await router.createWebRtcTransport({
        listenIps: [
          { 
            ip: process.env.MEDIASOUP_LISTEN_IP || '0.0.0.0', 
            // CRITICAL: On Render, this MUST be set in ENV to the Render instance Public IP
            announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP || '127.0.0.1' 
          }
        ],
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
      });

      transports.set(transport.id, transport);

      callback({
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
      });
    } catch (error: any) {
      callback({ error: error.message });
    }
  });

  // 3. Connect Transport (Exchange Security Keys)
  socket.on('connectTransport', async ({ transportId, dtlsParameters }, callback) => {
    try {
      const transport = transports.get(transportId);
      if (!transport) throw new Error(`Transport ${transportId} not found`);
      
      await transport.connect({ dtlsParameters });
      callback({ success: true });
    } catch (error: any) {
      callback({ error: error.message });
    }
  });

  // 4. Produce (Receive Media from Client)
  socket.on('produce', async ({ transportId, kind, rtpParameters, appData }, callback) => {
    try {
      const transport = transports.get(transportId);
      if (!transport) throw new Error(`Transport ${transportId} not found`);

      const producer = await transport.produce({ kind, rtpParameters, appData });
      producers.set(producer.id, producer);

      // Notify everyone else in the room that a new stream is available
      if (socket.data.roomId) {
        socket.broadcast.to(socket.data.roomId).emit('newProducer', { 
          producerId: producer.id, 
          socketId: socket.id,
          kind 
        });
      }

      callback({ id: producer.id });
    } catch (error: any) {
      callback({ error: error.message });
    }
  });

  // 5. Consume (Send Media to Client)
  socket.on('consume', async ({ transportId, producerId, rtpCapabilities }, callback) => {
    try {
      const router = rooms.get(socket.data.roomId);
      const transport = transports.get(transportId);
      
      if (!router || !transport) throw new Error('Router or Transport not found');
      if (!router.canConsume({ producerId, rtpCapabilities })) throw new Error('Cannot consume');

      const consumer = await transport.consume({
        producerId,
        rtpCapabilities,
        paused: true, // Always start paused to prevent race conditions
      });

      consumers.set(consumer.id, consumer);

      callback({
        id: consumer.id,
        producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
      });
    } catch (error: any) {
      callback({ error: error.message });
    }
  });

  // 6. Resume Consumer (Starts the flow of video/audio)
  socket.on('resume', async ({ consumerId }, callback) => {
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
    // In a full production app, we would loop through and close their transports here
  });
});

app.get('/health', (req, res) => res.json({ status: "Active", service: "ZynMeet SFU" }));

// Boot the SFU Server
const PORT = process.env.SFU_PORT || process.env.PORT || 4001;

async function bootstrap() {
  await createWorkers();
  
  httpServer.listen(PORT, () => {
    console.log(`[SFU] Mediasoup Signaling Server running on port ${PORT}`);
  });
}

bootstrap().catch((err) => {
  console.error('[SFU] Boot error:', err);
});
