import { randomBytes, randomUUID } from 'node:crypto';
import { redis } from '../utils/redisClient.js';
import { env } from '../config/env.js';

const ALPHABET62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const MASK_6BITS = 0b111111;

function genToken(length = 12): string {
  let out = '';
  while (out.length < length) {
    const buf = randomBytes(Math.ceil((length - out.length) * 1.6));
    for (let i = 0; i < buf.length && out.length < length; i++) {
      const b = buf[i];
      if (b !== undefined) {
        const v = b & MASK_6BITS;
        const char = ALPHABET62[v];
        if (v < 62 && char !== undefined) {
          out += char;
        }
      }
    }
  }
  return out;
}

const tokenKey = (t: string) => `token:${t}`;
const sessSetKey = (sid: string) => `sess:${sid}:tokens`;

// ioredis / node-redis compat helper for SET NX
async function setNX(key: string, val: string): Promise<boolean> {
  const r: any = redis as any;
  try {
    const res = await r.set(key, val, 'NX');
    if (res === 'OK') return true;
    if (res === null) return false;
  } catch {}
  try {
    const res = await r.set(key, val, { NX: true });
    return res === 'OK';
  } catch {
    return false;
  }
}

export async function createSessionTokenPair(sessionId?: string) {
  const id = sessionId ?? randomUUID();
  let token = '';

  for (;;) {
    token = genToken(env.AUTH_TOKEN_LEN);
    const ok = await setNX(tokenKey(token), id);
    if (ok) break;
  }

  await (redis as any).sadd(sessSetKey(id), token);
  return { id, token };
}

export async function getSessionIdByToken(token: string): Promise<string | null> {
  return redis.get(tokenKey(token));
}
