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

const app = express();
const httpServer = createServer(app);

// Socket.io Signaling Server Setup
const io = new Server(httpServer, {
  cors: {
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'POST'],
  },
});

let workers: Worker[] = [];
let nextWorkerIdx = 0;
const rooms = new Map<string, Router>();

// ZynMeet MVP Codec Configuration (H.264 for iOS, VP9 for Chrome, 48kHz Opus)
const mediaCodecs: RtpCodecCapability[] = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
    preferredPayloadType: 111, // Added
    rtcpFeedback: [
      { type: 'transport-cc' }
    ]
  },
  {
    kind: 'video',
    mimeType: 'video/VP9',
    clockRate: 90000,
    preferredPayloadType: 100, // Added
    parameters: {
      'profile-id': 2,
      'x-google-start-bitrate': 1000,
    },
    rtcpFeedback: [
      { type: 'nack' }, // Packet loss recovery
      { type: 'nack', parameter: 'pli' }, // Keyframe request
      { type: 'ccm', parameter: 'fir' },
      { type: 'goog-remb' }, // Bandwidth estimation
      { type: 'transport-cc' }
    ]
  },
  {
    kind: 'video',
    mimeType: 'video/h264',
    clockRate: 90000,
    preferredPayloadType: 102, // Added
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
  // Sized to CPU core count as per architecture, minimum 2 for dev
  const numWorkers = process.env.NODE_ENV === 'production' 
  ? os.cpus().length 
  : 1; 

console.log(`[SFU] Spawning ${numWorkers} Mediasoup workers...`);

  for (let i = 0; i < numWorkers; i++) {
    const worker = await mediasoup.createWorker({
      logLevel: 'warn',
      rtcMinPort: parseInt(process.env.MIN_PORT || '10000', 10),
      rtcMaxPort: parseInt(process.env.MAX_PORT || '59999', 10),
    });

    worker.on('died', () => {
      console.error(`[SFU] Mediasoup worker ${worker.pid} died, exiting in 2 seconds...`);
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

// WebSocket connection handling
io.on('connection', (socket) => {
  console.log(`[Signaling] Peer connected: ${socket.id}`);

  socket.on('disconnect', () => {
    console.log(`[Signaling] Peer disconnected: ${socket.id}`);
    // Cleanup logic for Peer transports will go here
  });

  // Future MVP Events: createRoom, joinRoom, getRouterRtpCapabilities, etc.
});

// Boot the SFU Server
const PORT = process.env.SFU_PORT || 4001;

async function bootstrap() {
  await createWorkers();
  
  httpServer.listen(PORT, () => {
    console.log(`[SFU] Mediasoup Signaling Server running on port ${PORT}`);
  });
}

bootstrap().catch((err) => {
  console.error('[SFU] Boot error:', err);
});
