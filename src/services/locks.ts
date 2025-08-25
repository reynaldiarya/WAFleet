/**
 * locks.ts — Distributed mutex berbasis Redis untuk mengunci operasi per `sessionId`.
 *
 * Tujuan umum:
 * - Menjamin hanya ADA SATU proses/worker yang melakukan operasi kritikal pada session yang sama
 *   (mis. create/restore Baileys session, reconnect/backoff, tulis kredensial), sehingga
 *   mencegah race condition dan korupsi state.
 */
import { randomUUID } from 'node:crypto';
import type { Redis as RedisClient } from 'ioredis';
import { env } from '../config/env.js';

const LOCK_TTL_MS = (env as any).LOCK_TTL_MS ?? 10_000; // TTL lock (ms) — harus > interval renew
const RENEW_EVERY_MS = (env as any).LOCK_RENEW_EVERY_MS ?? 5_000; // Interval perpanjang TTL (ms)

export interface SessionLock {
  key: string;
  token: string;
  renewTimer?: NodeJS.Timeout;
  /** Lepaskan lock (idempotent). Hanya menghapus jika token cocok. */
  release: () => Promise<void>;
}

/**
 * Acquire distributed lock untuk sessionId.
 * - Menulis key `lock:wa:<sessionId>` di Redis dengan value `token` unik.
 * - Memakai SET NX PX supaya tidak menimpa lock yang sudah ada.
 * - Auto-renew TTL secara berkala hanya jika value-nya masih milik kita (token cocok).
 */
export async function acquireSessionLock(
  redis: RedisClient,
  sessionId: string
): Promise<SessionLock | null> {
  const key = `lock:wa:${sessionId}`;
  const token = randomUUID(); // identitas pemegang lock

  // === 1) Acquire: SET key token NX PX TTL ===
  // Hanya berhasil kalau key belum ada (NX). TTL ditetapkan supaya lock auto-expire kalau pemegangnya mati.
  const ok = await redis.set(key, token, 'PX', LOCK_TTL_MS, 'NX');
  if (ok !== 'OK') return null;

  // === Lua scripts untuk operasi atomik berdasar token ===
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

  // === 2) Auto-renew TTL secara periodik ===
  // Pakai Lua agar perpanjang TTL hanya terjadi jika lock masih milik kita (value = token).
  const renew = async () => {
    try {
      const res = await redis.eval(RENEW_LUA, 1, key, token, String(LOCK_TTL_MS));
      // Jika res == 0, lock sudah bukan milik kita (expired/diambil orang lain) → hentikan renew.
      if (res === 0) clearInterval(renewTimer);
    } catch {
      // Biarkan gagal sementara; interval berikutnya akan coba lagi.
      // (opsional: tambah log di sini)
    }
  };
  const renewTimer = setInterval(renew, RENEW_EVERY_MS);
  // Jangan tahan event loop saat shutdown
  renewTimer.unref?.();

  // === 3) Release aman: hanya hapus jika token cocok ===
  const release = async () => {
    clearInterval(renewTimer);
    try {
      await redis.eval(RELEASE_LUA, 1, key, token);
    } catch {
      // swallow error; release bersifat best-effort
    }
  };

  return { key, token, renewTimer, release };
}
