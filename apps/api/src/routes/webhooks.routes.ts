import express from 'express';
import crypto from 'crypto';
import { db } from '../lib/db';

const router = express.Router();

router.post('/paystack', express.raw({ type: 'application/json' }), async (req, res) => {
    // 1. HMAC SECURITY CHECK (Section 12B of PRD)
    const secret = process.env.PAYSTACK_SECRET_KEY!;
    const hash = crypto.createHmac('sha512', secret).update(req.body).digest('hex');

    if (hash !== req.headers['x-paystack-signature']) {
        return res.status(401).send('Tamper Detected');
    }

    const event = JSON.parse(req.body.toString());

    // 2. IDEMPOTENT PROCESSING
    if (event.event === 'charge.success') {
        const { amount, reference, customer } = event.data;
        const userId = event.data.metadata.user_id; // Frontend passes this in metadata

        // 3. ATOMIC LEDGER INSERT (Append-only)
        await db.$transaction([
            db.walletLedger.create({
                data: {
                    userId,
                    amount: amount, // Kobo
                    type: 'CREDIT',
                    reference: reference
                }
            }),
            db.user.update({
                where: { id: userId },
                data: { walletBalance: { increment: amount } }
            })
        ]);
        
        console.log(`Naira Credited: ${amount / 100} to User ${userId}`);
    }

    res.sendStatus(200);
});

export default router;
