import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { db } from '../lib/db';
import { io } from '../index'; 

// $500k Production logic: Cloud Redis (Upstash) requires TLS/SSL options
const redisOptions: any = {
    maxRetriesPerRequest: null, 
    enableReadyCheck: false,
    connectTimeout: 20000, // Nigerian network latency buffer
};

// Check if it's a cloud URL (rediss://)
if (process.env.REDIS_URL?.startsWith('rediss://')) {
    redisOptions.tls = {
        rejectUnauthorized: false // Required for most Node.js -> Upstash connections
    };
}

const connection = new IORedis(process.env.REDIS_URL!, redisOptions);

connection.on('connect', () => console.log('✅ BILLING: Redis Handshake Successful'));
connection.on('error', (err) => console.error('❌ BILLING: Redis Link Error:', err.message));

export const billingQueue = new Queue('billing-engine', { connection });

// Function to start a 30-minute block for a user
export const startBillingBlock = async (userId: string, roomId: string) => {
    const jobId = `billing-${userId}-${roomId}-${Date.now()}`;
    // PRD Section 1B: The 30-minute gate
    await billingQueue.add('check-wallet', 
        { userId, roomId }, 
        { delay: 30 * 60 * 1000, jobId }
    );
    console.log(`⏱️  GATE SET: Block for ${userId} triggers in 30m`);
};

// THE WORKER: Executes the N100 deduction
export const billingWorker = new Worker('billing-engine', async (job) => {
    const { userId, roomId } = job.data;
    
    // Fetch user and check against the production field 'walletRecord'
    const user = await db.user.findUnique({ 
        where: { id: userId },
        include: { walletRecord: true } 
    });
    
    const currentBalance = user?.walletRecord?.balance || 0;
    
    // IF USER BROKE: START 2-MIN GRACE (PRD SECTION 1B)
    if (!user || currentBalance < 10000) {
        console.warn(`💸 WALLET EMPTY: User ${userId} entering Grace Period.`);
        
        // Signal UI (Client listens to their private 'user:ID' channel)
        io.to(`user:${userId}`).emit('billing:grace_start', {
            secondsRemaining: 120,
            msg: "N100 needed for the next 30-min block."
        });

        // Add Disconnect Job
        await billingQueue.add('hard-disconnect', 
            { userId, roomId }, 
            { delay: 120 * 1000 } 
        );
        return;
    }

    // SUCCESSFUL DEDUCTION (Double-Entry Ledger Pattern)
    try {
        await db.$transaction([
            // 1. Audit Entry
            db.walletLedger.create({
                data: {
                    userId,
                    amount: -10000, // DEBIT
                    type: 'DEBIT',
                    eventId: `RENEWAL-${userId}-${Date.now()}`
                }
            }),

            // 2. Real balance
            db.walletBalance.update({
                where: { userId },
                data: { balance: { decrement: 10000 } }
            }),
            
            // 3. Update fast-cache balance in User table
            db.user.update({
                where: { id: userId },
                data: { walletBalance: { decrement: 10000 } }
            })
        ]);

        console.log(`💰 BLOCK RENEWED: User ${userId}. Next check in 30m.`);
        io.to(`user:${userId}`).emit('billing:renewed', { newBalance: currentBalance - 10000 });

        // Loop the check
        await startBillingBlock(userId, roomId);
        
    } catch (error) {
        console.error("FATAL LEDGER ERROR:", error);
    }
}, { connection });
