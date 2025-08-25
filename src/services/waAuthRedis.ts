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

/**
 * Auth store Baileys berbasis Redis (min IO).
 *
 * Keyspace/namespace yang dipakai:
 *   - `baileys:{sessionId}:creds`               → objek AuthenticationCreds (JSON dengan BufferJSON)
 *   - `baileys:{sessionId}:{type}:{id}`         → berbagai Signal keys (preKey, session, sender-key, dll.)
 *
 * Catatan:
 * - `BufferJSON` wajib untuk serialize/deserialize agar buffer tersimpan dengan benar.
 * - `makeCacheableSignalKeyStore` menambahkan cache in-memory agar read ke Redis tidak terlalu sering.
 * - Tidak ada TTL: kredensial dan keys bersifat persist sampai dihapus (mis. via deleteRedisAuth).
 */
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

  // --- Load creds (atau init baru jika belum ada / korup) ---
  const savedCreds = await redis.get(kCreds);
  let creds: AuthenticationCreds;
  if (savedCreds) {
    try {
      creds = JSON.parse(savedCreds, BufferJSON.reviver);
    } catch (e) {
      // Jika data korup (jarang terjadi), log & fallback ke init.
      logger?.warn({ err: e, sessionId }, 'Failed to parse creds JSON; reinitializing creds');
      creds = initAuthCreds();
    }
  } else {
    creds = initAuthCreds();
  }

  /** Persist kredensial utama (dipanggil saat `creds.update`) */
  async function saveCreds() {
    await redis.set(kCreds, JSON.stringify(creds, BufferJSON.replacer));
  }

  // --- Implementasi SignalKeyStore di atas Redis ---
  const rawKeyStore: SignalKeyStore = {
    /**
     * Batch get untuk berbagai jenis key (preKey, session, sender-key, dll).
     * Menggunakan MGET untuk efisiensi roundtrip.
     */
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
          } catch {
            // Jika satu key korup, biarkan saja tidak dimasukkan ke out
            // (Baileys akan regenerate bila perlu).
          }
        }
      });
      return out;
    },

    /**
     * Batch set/unset.
     * - Nilai `null/undefined` → DEL key
     * - Nilai ada → SET key JSON
     * Menggunakan MULTI/EXEC agar atomik (boleh diganti PIPELINE jika tak perlu atomicity).
     */
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

  // Tambahkan cache in-memory untuk mengurangi beban Redis
  const state = {
    creds,
    keys: makeCacheableSignalKeyStore(rawKeyStore, logger),
  };

  return { state, saveCreds };
}

/**
 * Hapus SEMUA data auth untuk satu session dari Redis (kredensial Baileys) DAN
 * CABUT SEMUA token API yang terkait session tsb (wajib).
 *
 * Yang dihapus:
 * - Semua key `baileys:{sessionId}:*` (creds & signal keys)
 * - Set `sess:{sessionId}:tokens` dan semua mapping `token:<token>` untuk session tsb
 *
 * Efek:
 * - Perangkat WA Web benar-benar logout (kredensial hilang → perlu scan QR lagi).
 * - Semua Bearer token API untuk session tsb langsung invalid.
 */
export async function deleteRedisAuth(
  sessionId: string,
  redis: RedisClient
): Promise<{ ok: true }> {
  // Namespace/token key helpers
  const baileysPattern = `baileys:${sessionId}:*`; // kredensial/keys WA (Baileys)
  const sessSetKey = `sess:${sessionId}:tokens`; // set daftar token API milik session
  const tokenKey = (t: string) => `token:${t}`; // mapping token -> sessionId

  // 1) Revoke semua token API milik session
  const tokens = await redis.smembers(sessSetKey);
  const p = redis.pipeline();
  if (tokens.length) {
    const tokenKeys = tokens.map(tokenKey);
    // Catatan: jika Redis >= 4 dan latency-sensitive, bisa pakai UNLINK (non-blocking)
    // ganti p.del(...tokenKeys) ⇒ p.unlink(...tokenKeys)
    p.del(...tokenKeys);
  }
  p.del(sessSetKey);

  // (Opsional) Jika kamu menyimpan daftar semua session di `sessions:all`,
  // bisa sekalian hapus di sini:
  // p.srem('sessions:all', sessionId)

  // 2) Hapus semua kredensial & key Baileys untuk session ini
  let cursor = '0';
  do {
    // SCAN non-blocking dibanding KEYS, aman untuk keyspace besar
    const [next, keys] = await redis.scan(cursor, 'MATCH', baileysPattern, 'COUNT', 200);
    if (keys.length) {
      // Sama seperti di atas: bisa p.unlink(...keys) jika ingin non-blocking
      p.del(...keys);
    }
    cursor = next;
  } while (cursor !== '0');

  await p.exec();
  return { ok: true };
}
