declare namespace NodeJS {
  interface ProcessEnv {
    NODE_ENV?: 'development' | 'test' | 'production';
    LOG_LEVEL?: 'silent' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
    PORT?: string;

    REDIS_URL?: string;
    REDIS_SOCKET_PATH?: string;
    REDIS_HOST?: string;
    REDIS_PORT?: string;
    REDIS_PASSWORD?: string;

    ALLOWED_ORIGINS?: string;
    RATE_LIMIT_WINDOW_MS?: string;
    RATE_LIMIT_MAX?: string;

    WS_RECONNECT_MIN_MS?: string;
    WS_RECONNECT_MAX_MS?: string;

    RESTORE_SCAN_COUNT?: string;
    RESTORE_LOCK_RETRIES?: string;
    RESTORE_LOCK_RETRY_DELAY_MS?: string;
    AUTO_RESTORE_STARTUP_DELAY_MS?: string;

    LOCK_TTL_MS?: string;
    LOCK_RENEW_EVERY_MS?: string;

    AUTH_TOKEN_LEN?: string;
  }
}
