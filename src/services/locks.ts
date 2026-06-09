import { randomUUID } from 'node:crypto';
import type { Redis as RedisClient } from 'ioredis';
import { env } from '../config/env.js';

const LOCK_TTL_MS = (env as any).LOCK_TTL_MS ?? 10_000;
const RENEW_EVERY_MS = (env as any).LOCK_RENEW_EVERY_MS ?? 5_000;

export interface SessionLock {
  key: string;
  token: string;
  renewTimer?: NodeJS.Timeout;
  release: () => Promise<void>;
}

/**
 * Acquires a distributed lock for sessionId using Redis.
 */
export async function acquireSessionLock(
  redis: RedisClient,
  sessionId: string
): Promise<SessionLock | null> {
  const key = `lock:wa:${sessionId}`;
  const token = randomUUID();

  const ok = await redis.set(key, token, 'PX', LOCK_TTL_MS, 'NX');
  if (ok !== 'OK') return null;

  // Lua scripts to ensure atomic check-and-expire / check-and-delete
  const RENEW_LUA = `
    if redis.call("GET", KEYS[1]) == ARGV[1] then
      return redis.call("PEXPIRE", KEYS[1], ARGV[2])
    else
      return 0
    end
  `;
  const RELEASE_LUA = `
    if redis.call("GET", KEYS[1]) == ARGV[1] then
      return redis.call("DEL", KEYS[1])
    else
      return 0
    end
  `;

  const renew = async () => {
    try {
      const res = await redis.eval(RENEW_LUA, 1, key, token, String(LOCK_TTL_MS));
      if (res === 0) clearInterval(renewTimer);
    } catch {}
  };
  const renewTimer = setInterval(renew, RENEW_EVERY_MS);
  renewTimer.unref?.();

  const release = async () => {
    clearInterval(renewTimer);
    try {
      await redis.eval(RELEASE_LUA, 1, key, token);
    } catch {}
  };

  return { key, token, renewTimer, release };
}
