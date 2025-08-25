// Global typing untuk process.env agar auto-complete & type-check enak.
declare namespace NodeJS {
  interface ProcessEnv {
    // Mode & logging
    NODE_ENV?: 'development' | 'test' | 'production';
    LOG_LEVEL?: 'silent' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

    // HTTP server
    PORT?: string;

    // Redis (pilih salah satu: URL atau host/port/password)
    REDIS_URL?: string;
    REDIS_SOCKET_PATH?: string;
    REDIS_HOST?: string;
    REDIS_PORT?: string;
    REDIS_PASSWORD?: string;

    // CORS & rate limit
    ALLOWED_ORIGINS?: string; // contoh: "*" atau "https://a.com,https://b.com"
    RATE_LIMIT_WINDOW_MS?: string; // ms, mis. "60000"
    RATE_LIMIT_MAX?: string; // jumlah permintaan per window

    // Reconnect/backoff WS
    WS_RECONNECT_MIN_MS?: string; // mis. "2000"
    WS_RECONNECT_MAX_MS?: string; // mis. "30000"

    // Auto-restore session (startup & lazy)
    RESTORE_SCAN_COUNT?: string; // Umum 100–500
    RESTORE_LOCK_RETRIES?: string; // Jumlah retry saat createSession terkena 423 (locked). 0–3 biasanya cukup
    RESTORE_LOCK_RETRY_DELAY_MS?: string; // Jeda antar retry (ms). Sebaiknya <= TTL lock.
    AUTO_RESTORE_STARTUP_DELAY_MS?: string; // Jeda setelah server start sebelum auto-restore berjalan (ms)

    // Distributed lock (locks.ts)
    LOCK_TTL_MS?: string; // mis. "10.000–30.000"
    LOCK_RENEW_EVERY_MS?: string; // Disarankan ≈ 1/2–1/3 dari TTL
  }
}
