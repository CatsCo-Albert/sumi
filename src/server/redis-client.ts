/**
 * Redis client (singleton, optional).
 *
 * If REDIS_URL is not set, getRedis() returns null and callers should
 * fall back to in-memory behavior.
 */

import Redis from "ioredis";

let redisInstance: Redis | null = null;
let isConnecting = false;
let connectionPromise: Promise<Redis> | null = null;

async function createRedisConnection(): Promise<Redis> {
  const redisUrl = process.env.REDIS_URL!;
  const client = new Redis(redisUrl, {
    lazyConnect: false,
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => Math.min(times * 200, 2000),
  });

  await new Promise<void>((resolve, reject) => {
    client.once("ready", () => resolve());
    client.once("error", (err) => reject(err));
  });

  return client;
}

export async function getRedis(): Promise<Redis | null> {
  if (!process.env.REDIS_URL) return null;

  if (redisInstance && redisInstance.status === "ready") {
    return redisInstance;
  }
  if (isConnecting && connectionPromise) return connectionPromise;

  isConnecting = true;
  connectionPromise = createRedisConnection();
  try {
    redisInstance = await connectionPromise;
    return redisInstance;
  } finally {
    isConnecting = false;
    connectionPromise = null;
  }
}

export async function closeRedis(): Promise<void> {
  if (redisInstance) {
    await redisInstance.quit().catch(() => undefined);
    redisInstance = null;
  }
}
