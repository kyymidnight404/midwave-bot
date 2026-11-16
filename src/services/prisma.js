import prismaPkg from '@prisma/client';

const { PrismaClient } = prismaPkg;

process.env.DATABASE_URL ??= 'file:./dev.db';
export const prisma = new PrismaClient();

