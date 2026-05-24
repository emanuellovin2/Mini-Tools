import { Redis } from "@upstash/redis";

const redis =
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    ? new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
      })
    : null;

// Fallback for local dev — ephemeral per cold-start, not suitable for production
const localBuckets = new Map<string, { count: number; windowStart: number }>();

export async function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number
): Promise<{ allowed: boolean; remaining: number }> {
  if (redis) {
    const windowKey = `rl:${key}:${Math.floor(Date.now() / windowMs)}`;
    const count = await redis.incr(windowKey);
    if (count === 1) await redis.expire(windowKey, Math.ceil(windowMs / 1000));
    return {
      allowed: count <= limit,
      remaining: Math.max(0, limit - count),
    };
  }

  const now = Date.now();
  const bucket = localBuckets.get(key);
  if (!bucket || now - bucket.windowStart > windowMs) {
    localBuckets.set(key, { count: 1, windowStart: now });
    return { allowed: true, remaining: limit - 1 };
  }
  if (bucket.count >= limit) return { allowed: false, remaining: 0 };
  bucket.count++;
  return { allowed: true, remaining: limit - bucket.count };
}
