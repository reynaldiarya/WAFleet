/**
 * Middleware autentikasi berbasis Bearer Token.
 *
 * Tujuan:
 * - Membaca header `Authorization: Bearer <token>`
 * - Validasi format token (panjang, karakter dasar)
 * - Resolve token → sessionId via token store (Redis)
 * - Menyematkan `req.sessionId` dan `req.token` untuk dipakai handler berikutnya
 *
 * Catatan:
 * - Pastikan CORS mengizinkan header `Authorization`.
 * - Token tidak memiliki expiry otomatis (by design). Revoke dilakukan manual
 *   dengan menghapus mapping token dari Redis.
 * - Untuk typing yang lebih rapi, Anda bisa menambahkan declaration merging:
 *     declare global {
 *       namespace Express {
 *         interface Request { sessionId?: string; token?: string }
 *       }
 *     }
 *   (Namun di sini kita tetap pakai `(req as any)` agar tidak mengubah konfigurasi TS Anda.)
 */

import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import { getSessionIdByToken } from '../services/tokenStore.js';

/**
 * Mengambil nilai token dari header `Authorization`.
 * Menerima bentuk:
 *   Authorization: Bearer <token>
 * Jika tidak sesuai → mengembalikan null.
 */
function parseBearer(auth?: string): string | null {
  if (!auth) return null;
  if (auth.length > env.AUTH_TOKEN_LEN) {
    throw new Error('Input too long');
  }
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7).trim();
  return token || null;
}

/**
 * Validasi dasar token:
 * - Minimal 10 karakter (menghindari input trivial)
 * - Maksimal 512 karakter (batas wajar untuk header)
 * (Format spesifik token di-generate oleh `genToken()` pada tokenStore)
 */
const TokenSchema = z.string().min(10).max(512);

/**
 * Middleware utama:
 * 1) Ambil token dari header Authorization
 * 2) Validasi bentuk token
 * 3) Cari mapping token → sessionId di Redis (via tokenStore)
 * 4) Kalau valid, set ke `req.sessionId` dan `req.token`, lalu `next()`
 */
export async function requireAuthToken(req: Request, res: Response, next: NextFunction) {
  const token = parseBearer(req.headers.authorization);
  if (!token) return res.status(401).json({ error: 'Authorization: Bearer <token> wajib' });

  const parsed = TokenSchema.safeParse(token);
  if (!parsed.success) return res.status(400).json({ error: 'Token tidak valid' });

  const sessionId = await getSessionIdByToken(token);
  if (!sessionId) return res.status(401).json({ error: 'Token tidak dikenali' });

  // Simpan ke request untuk dipakai di handler berikutnya
  (req as any).sessionId = sessionId;
  (req as any).token = token;

  next();
}
