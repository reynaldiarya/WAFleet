import type { Redis as RedisClient } from 'ioredis';
import {
  initAuthCreds,
  BufferJSON,
  makeCacheableSignalKeyStore,
  type AuthenticationCreds,
  type SignalDataTypeMap,
  type SignalKeyStore,
} from 'baileys';
import type { Logger } from 'pino';

export async function useRedisAuth(
  sessionId: string,
  redis: RedisClient,
  logger?: Logger
): Promise<{
  state: { creds: AuthenticationCreds; keys: SignalKeyStore };
  saveCreds: () => Promise<void>;
}> {
  const base = `baileys:${sessionId}:`;
  const kCreds = `${base}creds`;
  const keyOf = (type: keyof SignalDataTypeMap, id: string) => `${base}${String(type)}:${id}`;

  const savedCreds = await redis.get(kCreds);
  let creds: AuthenticationCreds;
  if (savedCreds) {
    try {
      creds = JSON.parse(savedCreds, BufferJSON.reviver);
    } catch (e) {
      logger?.warn({ err: e, sessionId }, 'Failed to parse creds JSON; reinitializing creds');
      creds = initAuthCreds();
    }
  } else {
    creds = initAuthCreds();
  }

  async function saveCreds() {
    await redis.set(kCreds, JSON.stringify(creds, BufferJSON.replacer));
  }

  const rawKeyStore: SignalKeyStore = {
    async get<T extends keyof SignalDataTypeMap>(
      type: T,
      ids: string[]
    ): Promise<{ [id: string]: SignalDataTypeMap[T] }> {
      if (!ids?.length) return {};
      const keys = ids.map((id) => keyOf(type, id));
      const vals = await redis.mget(keys);
      const out: { [id: string]: SignalDataTypeMap[T] } = {};
      ids.forEach((id, i) => {
        const v = vals[i];
        if (v) {
          try {
            out[id] = JSON.parse(v, BufferJSON.reviver);
          } catch {}
        }
      });
      return out;
    },

    async set(data) {
      const multi = redis.multi();
      for (const type of Object.keys(data) as (keyof SignalDataTypeMap)[]) {
        const byId = data[type];
        if (!byId) continue;
        for (const id of Object.keys(byId)) {
          const value = byId[id as keyof typeof byId];
          const k = keyOf(type, id);
          if (value === null || value === undefined) {
            multi.del(k);
          } else {
            multi.set(k, JSON.stringify(value, BufferJSON.replacer));
          }
        }
      }
      await multi.exec();
    },
  };

  const state = {
    creds,
    keys: makeCacheableSignalKeyStore(rawKeyStore, logger),
  };

  return { state, saveCreds };
}

export async function deleteRedisAuth(
  sessionId: string,
  redis: RedisClient
): Promise<{ ok: true }> {
  const baileysPattern = `baileys:${sessionId}:*`;
  const sessSetKey = `sess:${sessionId}:tokens`;
  const tokenKey = (t: string) => `token:${t}`;

  const tokens = await redis.smembers(sessSetKey);
  const p = redis.pipeline();
  if (tokens.length) {
    const tokenKeys = tokens.map(tokenKey);
    p.del(...tokenKeys);
  }
  p.del(sessSetKey);

  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', baileysPattern, 'COUNT', 200);
    if (keys.length) {
      p.del(...keys);
    }
    cursor = next;
  } while (cursor !== '0');

  await p.exec();
  return { ok: true };
}
