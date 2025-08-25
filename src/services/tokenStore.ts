import { randomBytes, randomUUID } from 'node:crypto';
import { redis } from '../utils/redisClient.js';

/**
 * Menghasilkan token acak untuk dipakai sebagai Bearer token.
 * - 32 bytes (256-bit) entropi → sangat sulit ditebak.
 * - Di-encode sebagai base64url (tanpa '+' '/' '='), aman dipakai di header/URL.
 */
function genToken(bytes = 32) {
  // base64url manual biar aman di header/URL dan kompatibel node
  return randomBytes(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Key Redis: mapping token -> sessionId, contoh: token:AbCd... */
const tokenKey = (t: string) => `token:${t}`;
/** Key Redis: set daftar token milik satu session, contoh: sess:<sid>:tokens */
const sessSetKey = (sid: string) => `sess:${sid}:tokens`;

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
  const token = genToken(32);

  // simpan mapping TANPA expiry (by design: token tidak otomatis expired)
  await redis.set(tokenKey(token), id);
  // buat reverse index utk revoke-all per session
  await redis.sadd(sessSetKey(id), token);

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
