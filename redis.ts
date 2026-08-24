import Redis from "ioredis";
import { logger } from "./logger";

let redis: Redis | null = null;

export function getRedis(): Redis | null {
  return redis;
}

export async function connectRedis(): Promise<Redis | null> {
  if (!process.env.REDIS_URL) {
    logger.warn("REDIS_URL not set — Redis features disabled (rate limiting falls back to memory)");
    return null;
  }

  try {
    redis = new Redis(process.env.REDIS_URL, {
      enableReadyCheck: true,
      maxRetriesPerRequest: 3,
      lazyConnect: true,
    });

    redis.on("error", (err) => {
      logger.error("Redis error", err);
    });

    redis.on("connect", () => {
      logger.info("Redis connected");
    });

    await redis.connect();
    return redis;
  } catch (err) {
    logger.warn("Redis connection failed — continuing without Redis", err);
    redis = null;
    return null;
  }
}

export async function setWithExpiry(
  key: string,
  value: string,
  ttlSeconds: number
): Promise<void> {
  if (!redis) return;
  await redis.set(key, value, "EX", ttlSeconds);
}

export async function getValue(key: string): Promise<string | null> {
  if (!redis) return null;
  return redis.get(key);
}

export async function deleteKey(key: string): Promise<void> {
  if (!redis) return;
  await redis.del(key);
}

export async function incrementWithExpiry(
  key: string,
  ttlSeconds: number
): Promise<number> {
  if (!redis) return 0;
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, ttlSeconds);
  }
  return count;
}
