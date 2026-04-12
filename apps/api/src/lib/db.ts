import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';

dotenv.config();

const globalForPrisma = global as unknown as { db: PrismaClient };

// Initialize without the configuration object - Prisma will auto-detect process.env.DATABASE_URL
export const db = globalForPrisma.db || new PrismaClient();

if (process.env.NODE_ENV !== 'production') globalForPrisma.db = db;
