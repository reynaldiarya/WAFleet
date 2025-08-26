import 'dotenv/config';
import { z } from 'zod';

/**
 * Skema environment untuk validasi & dokumentasi konfigurasi aplikasi.
 *
 * - File .env dibaca otomatis oleh `dotenv/config`.
 * - Semua nilai divalidasi oleh Zod; jika tidak valid, proses akan throw saat startup.
 * - Gunakan `z.coerce.number()` agar angka boleh ditulis sebagai string di .env (mis. "3000").
 */
export const EnvSchema = z.object({
  // Mode runtime aplikasi. Pengaruhi logging/optimasi, dsb.
  // Gunakan 'production' di server/hosting.
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // Port HTTP tempat Express listen.
  // Bisa tulis "3000" di .env, akan di-coerce jadi number.
  PORT: z.coerce.number().default(3000),

  // =========================
  // Konfigurasi Redis
  // =========================
  // URL koneksi Redis satu baris, contoh:
  //   REDIS_URL=redis://default:password@127.0.0.1:6379/0
  // Jika nilai ini DISET, umumnya akan DIUTAMAKAN dibanding host/port/password terpisah.
  // (Pastikan implementasi di utils/redisClient.js mengikuti aturan ini.)
  REDIS_URL: z.string().optional(),

  // Alternatif jika tidak pakai REDIS_URL:
  REDIS_SOCKET_PATH: z.string().optional(),

  // Alternatif jika tidak pakai REDIS_URL & REDIS_SOCKET_PATH:
  // Host Redis (default localhost)
  REDIS_HOST: z.string().default('127.0.0.1'),
  // Port Redis (default 6379)
  REDIS_PORT: z.coerce.number().default(6379),
  // Password Redis (opsional). Kosongkan jika Redis tidak pakai auth.
  REDIS_PASSWORD: z.string().optional(),

  // Level log aplikasi (cocok dengan pino):
  // - 'error' hanya error penting
  // - 'info' log standar produksi
  // - 'debug'/'trace' untuk investigasi
  LOG_LEVEL: z.enum(['silent', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // =========================
  // HTTP / API
  // =========================
  // Daftar origin yang diizinkan untuk CORS, dipisah koma.
  //   Contoh: "https://example.com, https://admin.example.com"
  // Gunakan '*' hanya untuk pengembangan/tes.
  ALLOWED_ORIGINS: z.string().default('*'),

  // Rate limit: jendela waktu (ms) dan jumlah maksimum request per IP dalam jendela tsb.
  //   Contoh default: 100 req / 60 detik per IP.
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60000),
  RATE_LIMIT_MAX: z.coerce.number().default(100),

  // =========================
  // Reconnect / Backoff untuk koneksi WS (mis. Baileys)
  // =========================
  // Minimal dan maksimal jeda backoff (ms) saat mencoba reconnect.
  // Naik-turun diatur di layanan terkait; ini hanya nilai batas.
  WS_RECONNECT_MIN_MS: z.coerce.number().default(2000), // 2 detik
  WS_RECONNECT_MAX_MS: z.coerce.number().default(30000), // 30 detik

  // Auto-restore (startup & lazy)
  RESTORE_SCAN_COUNT: z.coerce.number().default(200), // Hint COUNT untuk Redis SCAN per iterasi (bukan batas keras). 100–500 umum; makin besar = iterasi lebih sedikit tapi lebih berat.
  RESTORE_LOCK_RETRIES: z.coerce.number().default(2), // Jumlah retry saat createSession terkena 423 (locked). 0–3 biasanya cukup.
  RESTORE_LOCK_RETRY_DELAY_MS: z.coerce.number().default(1200), // Jeda antar retry (ms). Sebaiknya <= TTL lock.
  AUTO_RESTORE_STARTUP_DELAY_MS: z.coerce.number().default(1500), // Jeda setelah server start sebelum auto-restore dijalankan (ms) agar tidak tabrakan dengan proses lama yang belum shutdown.

  // Distributed lock (locks.ts)
  LOCK_TTL_MS: z.coerce.number().default(10_000), // TTL lock (ms). Harus > interval perpanjang (RENEW). Umum: 10–30 detik.
  LOCK_RENEW_EVERY_MS: z.coerce.number().default(5_000), // Interval perpanjang TTL (ms). Jaga kira-kira 1/2–1/3 dari LOCK_TTL_MS.

  // Panjang token otentikasi (karakter). Makin panjang = makin aman dari brute-force.
  AUTH_TOKEN_LEN: z.coerce.number().positive().default(100),
});

/**
 * `env` berisi nilai environment yang sudah tervalidasi & bertipe aman.
 * Akses di tempat lain: `import { env } from './config/env'`
 */
export const env = EnvSchema.parse(process.env);
