import 'dotenv/config';
import { z } from 'zod';

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),

  // Redis config
  REDIS_URL: z.string().optional(),
  REDIS_SOCKET_PATH: z.string().optional(),
  REDIS_HOST: z.string().default('127.0.0.1'),
  REDIS_PORT: z.coerce.number().default(6379),
  REDIS_PASSWORD: z.string().optional(),

  LOG_LEVEL: z.enum(['silent', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // API settings
  ALLOWED_ORIGINS: z.string().default('*'),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60000),
  RATE_LIMIT_MAX: z.coerce.number().default(100),

  // WS backoff
  WS_RECONNECT_MIN_MS: z.coerce.number().default(2000),
  WS_RECONNECT_MAX_MS: z.coerce.number().default(30000),

  // Session restore and lock settings
  RESTORE_SCAN_COUNT: z.coerce.number().default(200),
  RESTORE_LOCK_RETRIES: z.coerce.number().default(2),
  RESTORE_LOCK_RETRY_DELAY_MS: z.coerce.number().default(1200),
  AUTO_RESTORE_STARTUP_DELAY_MS: z.coerce.number().default(1500),
  LOCK_TTL_MS: z.coerce.number().default(10_000),
  LOCK_RENEW_EVERY_MS: z.coerce.number().default(5_000),

  AUTH_TOKEN_LEN: z.coerce.number().positive().default(100),
});

export const env = EnvSchema.parse(process.env);
