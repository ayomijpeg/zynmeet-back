import express, { Request, Response, Router } from 'express'; 
import crypto from 'crypto';
import { db } from '../lib/db';

const router = Router();

router.post('/paystack', express.raw({ type: 'application/json' }), async (req: Request, res: Response) => {
    const signature = req.headers['x-paystack-signature'] as string;
    const secret = process.env.PAYSTACK_WEBHOOK_SECRET || 'sk_test_placeholder';

    const hash = crypto.createHmac('sha512', secret).update(req.body).digest('hex');
    if (hash !== signature) return res.status(401).send('Invalid');

    const payload = JSON.parse(req.body.toString());
    
    if (payload.event === 'charge.success') {
        const { amount, reference, metadata } = payload.data;
        const userId = metadata.user_id;

        try {
            await db.$transaction([
                db.walletLedger.create({
                    data: { userId, amount, type: 'CREDIT', gateway: 'paystack', eventId: reference }
                }),
                db.walletBalance.upsert({
                    where: { userId },
                    update: { balance: { increment: amount } },
                    create: { userId, balance: amount }
                }),
                db.user.update({
                    where: { id: userId },
                    data: { walletBalance: { increment: amount } }
                })
            ]);
        } catch (e) { console.error("Webhook DB Fail", e); }
    }
    res.sendStatus(200);
});

export default router;
