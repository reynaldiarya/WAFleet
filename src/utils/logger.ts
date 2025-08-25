import pino from 'pino';
import { env } from '../config/env.js';

/**
 * Logger aplikasi (global) menggunakan Pino.
 *
 * - Level diambil dari ENV melalui `env.LOG_LEVEL`
 *   Pilihan: 'silent' | 'error' | 'warn' | 'info' | 'debug' | 'trace'
 *   Rekomendasi:
 *     • production  : 'info' (default)
 *     • development : 'debug' atau 'trace' saat investigasi
 *
 * - Output default berupa JSON satu baris per log (cocok untuk agregator log: Loki/ELK/Cloud Logging).
 *
 * Contoh penggunaan:
 *   logger.info('server started')
 *   logger.warn({ userId, ip }, 'suspicious activity')
 *   logger.error({ err }, 'unhandled error')
 */
export const logger = pino({
  level: env.LOG_LEVEL,
});
