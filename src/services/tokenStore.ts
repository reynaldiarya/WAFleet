import { randomBytes, randomUUID } from 'node:crypto';
import { redis } from '../utils/redisClient.js';

// ===== Base62 (A–Z a–z 0–9) tanpa '-' '_' =====
const ALPHABET62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const MASK_6BITS = 0b111111; // 0..63

function genToken(length = 12): string {
  let out = '';
  while (out.length < length) {
    const buf = randomBytes(Math.ceil((length - out.length) * 1.6));
    for (let i = 0; i < buf.length && out.length < length; i++) {
      const v = buf[i] & MASK_6BITS; // 0..63
      if (v < 62) out += ALPHABET62[v]; // tolak 62 & 63 (hindari bias)
    }
  }
  return out; // hanya [A-Za-z0-9]
}

/** Key Redis: mapping token -> sessionId, contoh: token:AbCd... */
const tokenKey = (t: string) => `token:${t}`;
/** Key Redis: set daftar token milik satu session, contoh: sess:<sid>:tokens */
const sessSetKey = (sid: string) => `sess:${sid}:tokens`;

// Kompat: ioredis ('NX') atau node-redis v4 ({ NX: true })
async function setNX(key: string, val: string): Promise<boolean> {
  // pakai any agar TS tidak protes per-klien
  const r: any = redis as any;
  // Coba gaya ioredis
  try {
    const res = await r.set(key, val, 'NX'); // no TTL
    if (res === 'OK') return true;
    if (res === null) return false; // ioredis bisa mengembalikan null kalau NX gagal
  } catch {
    /* fallthrough */
  }
  // Coba gaya node-redis v4
  try {
    const res = await r.set(key, val, { NX: true }); // no TTL
    return res === 'OK';
  } catch {
    // Kalau kedua-duanya gagal, anggap tidak set
    return false;
  }
}

/**
 * Membuat pasangan {id, token} baru untuk sebuah session.
 *
 * Alur:
 * - Jika sessionId belum diberikan → generate UUID v4 sebagai id session.
 * - Generate token acak base64url.
 * - Simpan mapping TANPA expiry (token tidak kadaluarsa otomatis):
 *     token:<token> = <sessionId>
 *   dan daftarkan token ke set:
 *     SADD sess:<sessionId>:tokens <token>
 *
 * Catatan:
 * - Disengaja tanpa TTL: revoke dilakukan manual (hapus key token + keluarkan dari set).
 * - Token collision secara praktis nyaris mustahil (256-bit entropi), maka tidak ada pengecekan tambahan.
 */
export async function createSessionTokenPair(sessionId?: string) {
  const id = sessionId ?? randomUUID();

  // Loop sampai dapat token unik (tabrakan sangat kecil; loop harus cepat selesai)
  let token = '';
  for (;;) {
    token = genToken(12); // panjang 12
    const ok = await setNX(tokenKey(token), id);
    if (ok) break; // unik: lanjut
    // kalau tidak ok (sudah ada), ulangi
  }

  // Index balik per session untuk revoke-all
  await (redis as any).sadd(sessSetKey(id), token);

  return { id, token };
}

/**
 * Mengambil sessionId dari sebuah token Bearer.
 * - Return string (sessionId) jika token valid.
 * - Return null jika token tidak dikenali / sudah direvoke.
 */
export async function getSessionIdByToken(token: string): Promise<string | null> {
  return redis.get(tokenKey(token));
}
