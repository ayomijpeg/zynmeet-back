import express, { Request, Response } from 'express'; // Added Response/Request types
import crypto from 'crypto';
import { db } from '../lib/db';

const router = express.Router();

// FIXED: Defined Request and Response types to prevent "implicitly has an 'any' type" on Render
router.post('/paystack', express.raw({ type: 'application/json' }), async (req: Request, res: Response) => {
    
    // 1. HMAC SECURITY CHECK (Section 12B of PRD)
    const secret = process.env.PAYSTACK_SECRET_KEY || 'sk_test_placeholder';
    const signature = req.headers['x-paystack-signature'] as string;
    
    const hash = crypto
        .createHmac('sha512', secret)
        .update(req.body)
        .digest('hex');

    if (hash !== signature) {
        return res.status(401).send('Tamper Detected');
    }

    const event = JSON.parse(req.body.toString());

    // 2. IDEMPOTENT PROCESSING
    if (event.event === 'charge.success') {
        const { amount, reference } = event.data;
        // Metadata is passed by our Frontend when initializing the payment
        const userId = event.data.metadata.user_id;

        try {
            // 3. ATOMIC TRANSACTION: Ensuring ledger and balance are both updated or both fail
            await db.$transaction([
                db.walletLedger.create({
                    data: {
                        userId: userId,
                        amount: amount, 
                        type: 'CREDIT',
                        gateway: 'paystack',
                        eventId: reference // FIX: Changed 'reference' to 'eventId' to match schema.prisma
                    }
                }),
                // Update balance cache in User model for fast lookups
                db.user.update({
                    where: { id: userId },
                    data: { walletBalance: { increment: amount } }
                }),
                // Update main record
                db.walletBalance.upsert({
                    where: { userId: userId },
                    update: { balance: { increment: amount } },
                    create: { userId: userId, balance: amount }
                })
            ]);
            
            console.log(`✅ FINANCE: Naira Credited (₦${amount / 100}) to User ${userId}`);
        } catch (error: any) {
            // P2002 = Unique Constraint Violation (meaning we already processed this eventId)
            if (error.code === 'P2002') {
                console.log(`♻️ IDEMPOTENCY: Already processed event ${reference}. Skipping.`);
            } else {
                console.error("❌ FINANCE ERROR:", error.message);
            }
        }
    }

    // PRD 13C: Webhook endpoints MUST return 200 immediately
    res.sendStatus(200);
});

export default router;
