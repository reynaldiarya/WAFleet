// HANYA satu import dari ioredis (default/class)
import { Redis as RedisClient } from 'ioredis';
import { env } from '../config/env.js';
import { logger } from './logger.js';

// Type akan diinfer otomatis oleh TS
// - Jika REDIS_URL ada dan tidak kosong → gunakan koneksi berbasis URL (bisa 'redis://' atau 'rediss://').
// - Jika tidak → fallback ke konfigurasi host/port/password terpisah.
export const redis =
  env.REDIS_URL && env.REDIS_URL.length > 0
    ? new RedisClient(env.REDIS_URL) // redis:// / rediss://
    : env.REDIS_SOCKET_PATH && env.REDIS_SOCKET_PATH.length > 0
      ? new RedisClient({ path: env.REDIS_SOCKET_PATH }) // <-- UNIX socket
      : new RedisClient({
          host: env.REDIS_HOST,
          port: env.REDIS_PORT,
          password: env.REDIS_PASSWORD,
        });

/**
 * Event hooks untuk visibilitas lifecycle koneksi.
 * - connect: TCP socket terbentuk (belum tentu READY)
 * - ready: handshake/hello selesai, siap menerima command
 * - end: koneksi ditutup
 * - error: error tingkat koneksi/command
 */
redis.on('connect', () => logger.info('[redis] connect'));
redis.on('ready', () => logger.info('[redis] ready'));
redis.on('end', () => logger.warn('[redis] end'));
redis.on('reconnecting', () => logger.warn('[redis] reconnecting'));
redis.on('error', (e) => logger.error({ err: e }, '[redis] error'));
