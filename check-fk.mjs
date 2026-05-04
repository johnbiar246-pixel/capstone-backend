import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const rows = await prisma.$queryRawUnsafe(
  "SELECT TABLE_NAME, CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = 'dbGulpCourse' AND CONSTRAINT_TYPE = 'FOREIGN KEY' ORDER BY TABLE_NAME"
);
console.log(JSON.stringify(rows, null, 2));
await prisma.$disconnect();
