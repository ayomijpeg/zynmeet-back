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

// FIX: Track active producers per room so late joiners can consume existing streams.
// Shape: roomId -> [{ producerId, socketId, kind }]
interface RoomProducerEntry {
  producerId: string;
  socketId: string;
  kind: 'audio' | 'video';
}
const roomProducers = new Map<string, RoomProducerEntry[]>();

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

// Helper: Clean up all resources owned by a socket on disconnect
function cleanupSocket(socketId: string, roomId?: string) {
  // Remove this peer's producers from the room registry
  if (roomId) {
    const list = roomProducers.get(roomId) || [];
    const updated = list.filter((p) => p.socketId !== socketId);
    if (updated.length > 0) {
      roomProducers.set(roomId, updated);
    } else {
      roomProducers.delete(roomId);
    }
  }

  // Close & remove producers owned by this socket
  for (const [id, producer] of producers.entries()) {
    if ((producer.appData as any)?.socketId === socketId) {
      producer.close();
      producers.delete(id);
    }
  }

  // Close & remove consumers owned by this socket
  for (const [id, consumer] of consumers.entries()) {
    if ((consumer.appData as any)?.socketId === socketId) {
      consumer.close();
      consumers.delete(id);
    }
  }

  // Close & remove transports owned by this socket
  for (const [id, transport] of transports.entries()) {
    if ((transport.appData as any)?.socketId === socketId) {
      transport.close();
      transports.delete(id);
    }
  }
}

// --- MEDIASOUP SIGNALING PIPELINE ---
io.on('connection', (socket) => {
  console.log(`[SFU Signaling] Peer connected: ${socket.id}`);

  // 0. Join SFU Room
  // FIX: Client MUST call this before any other SFU event so socket.data.roomId
  // is set and socket.broadcast.to(roomId) works correctly.
  socket.on('join-sfu-room', ({ roomId }: { roomId: string }) => {
    socket.join(roomId);
    socket.data.roomId = roomId;
    console.log(`[SFU] Socket ${socket.id} joined media room ${roomId}`);
  });

  // 1. Send Router Capabilities
  socket.on('getRouterRtpCapabilities', async ({ roomId }: { roomId: string }, callback: Function) => {
    try {
      const router = await getOrCreateRouter(roomId);
      callback(router.rtpCapabilities);
    } catch (error: any) {
      callback({ error: error.message });
    }
  });

  // 2. Create WebRTC Transport
  socket.on('createWebRtcTransport', async ({ roomId }: { roomId: string }, callback: Function) => {
    try {
      const router = await getOrCreateRouter(roomId);

      const transport = await router.createWebRtcTransport({
        listenIps: [
          {
            ip: process.env.MEDIASOUP_LISTEN_IP || '0.0.0.0',
            // CRITICAL: On Render/any cloud, this MUST be the public IP of the instance
            announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP || '127.0.0.1'
          }
        ],
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
        // Tag the transport with the owning socketId for cleanup on disconnect
        appData: { socketId: socket.id },
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

  // 3. Connect Transport (Exchange DTLS Security Keys)
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

  // 4. Produce (Receive Media from Client → SFU)
  socket.on('produce', async ({ transportId, kind, rtpParameters, appData }: any, callback: Function) => {
    try {
      const transport = transports.get(transportId);
      if (!transport) throw new Error(`Transport ${transportId} not found`);

      const producer = await transport.produce({
        kind,
        rtpParameters,
        // FIX: Tag producer with owning socketId so cleanup works on disconnect
        appData: { ...appData, socketId: socket.id },
      });

      producers.set(producer.id, producer);

      // FIX: Register in roomProducers so late joiners can call getExistingProducers
      if (socket.data.roomId) {
        const list = roomProducers.get(socket.data.roomId) || [];
        list.push({ producerId: producer.id, socketId: socket.id, kind });
        roomProducers.set(socket.data.roomId, list);

        // Notify all OTHER peers in the room that a new stream is available
        socket.broadcast.to(socket.data.roomId).emit('newProducer', {
          producerId: producer.id,
          socketId: socket.id,
          kind,
        });
      }

      callback({ id: producer.id });
    } catch (error: any) {
      callback({ error: error.message });
    }
  });

  // FIX: New handler — returns all existing producers in the room to a late joiner.
  // Called by the client after its recv transport is ready, so it can consume
  // streams from peers who were already in the room before it joined.
  socket.on('getExistingProducers', ({ roomId }: { roomId: string }, callback: Function) => {
    try {
      const existing = roomProducers.get(roomId) || [];
      // Exclude the joining peer's own producers (they don't consume themselves)
      const others = existing.filter((p) => p.socketId !== socket.id);
      console.log(`[SFU] Sending ${others.length} existing producer(s) to late joiner ${socket.id}`);
      callback(others);
    } catch (error: any) {
      callback([]);
    }
  });

  // 5. Consume (SFU → Send Media to Client)
  socket.on('consume', async ({ transportId, producerId, rtpCapabilities }: any, callback: Function) => {
    try {
      const router = rooms.get(socket.data.roomId);
      const transport = transports.get(transportId);

      if (!router || !transport) throw new Error('Router or Transport not found');
      if (!router.canConsume({ producerId, rtpCapabilities })) {
        throw new Error(`Cannot consume producerId=${producerId} — incompatible RTP capabilities`);
      }

      const consumer = await transport.consume({
        producerId,
        rtpCapabilities,
        paused: true, // Always start paused; client resumes after track is ready
        // Tag consumer with owning socketId for cleanup on disconnect
        appData: { socketId: socket.id },
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

  // 6. Resume Consumer (Starts the actual flow of video/audio bytes to client)
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

  // FIX: Full cleanup on disconnect — close transports/producers/consumers
  // and remove from roomProducers so ghost streams don't linger.
  socket.on('disconnect', () => {
    console.log(`[SFU Signaling] Peer disconnected: ${socket.id}`);
    const roomId = socket.data.roomId;

    cleanupSocket(socket.id, roomId);

    // Notify remaining peers in the room that this peer left so they can
    // remove their video tile from the UI
    if (roomId) {
      socket.broadcast.to(roomId).emit('peerDisconnected', { socketId: socket.id });
    }
  });
});

app.get('/health', (req, res) => res.json({ status: 'Active', service: 'ZynMeet SFU' }));

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
