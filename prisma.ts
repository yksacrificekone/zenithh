import { PrismaClient } from "@prisma/client";
import { logger } from "./logger";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["query", "error", "warn"]
        : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export async function connectDB(): Promise<void> {
  try {
    await prisma.$connect();
    logger.info("PostgreSQL connected via Prisma");
  } catch (err) {
    logger.error("Failed to connect to PostgreSQL", err);
    process.exit(1);
  }
}
