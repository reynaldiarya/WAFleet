import { makeWASocket, DisconnectReason, type WASocket } from 'baileys';
import P, { type Logger } from 'pino';
import QRCode from 'qrcode';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { redis } from '../utils/redisClient.js';
import { useRedisAuth, deleteRedisAuth } from './waAuthRedis.js';
import { acquireSessionLock, type SessionLock } from './locks.js';

type SessionStatus = 'connecting' | 'open' | 'close';

export interface SessionEntry {
  sock: WASocket | null;
  status: SessionStatus;
  lastQr: string | null;
  userJid: string | null;
  reconnecting?: boolean;
  backoffMs?: number;
  backoffTimer?: NodeJS.Timeout | null;
  lock?: SessionLock;
}

const sessions: Record<string, SessionEntry> = {};

const RECONNECT_MIN = (env as any).WS_RECONNECT_MIN_MS ?? 2_000;
const RECONNECT_MAX = (env as any).WS_RECONNECT_MAX_MS ?? 30_000;
const SCAN_COUNT = (env as any).RESTORE_SCAN_COUNT ?? 200;
const RETRIES = (env as any).RESTORE_LOCK_RETRIES ?? 5;
const RETRY_DELAY_MS = (env as any).RESTORE_LOCK_RETRY_DELAY_MS ?? 2_000;

function resetBackoff(s: SessionEntry) {
  s.backoffMs = RECONNECT_MIN;
  if (s.backoffTimer) {
    clearTimeout(s.backoffTimer);
    s.backoffTimer = null;
  }
  s.reconnecting = false;
}

function scheduleReconnect(sessionId: string, reason: string) {
  const s = sessions[sessionId];
  if (!s || s.reconnecting) return;
  s.reconnecting = true;
  s.backoffMs = Math.min(s.backoffMs ? s.backoffMs * 2 : RECONNECT_MIN, RECONNECT_MAX);
  const delay = s.backoffMs!;
  logger.warn({ sessionId, reason, delay }, 'scheduleReconnect');

  s.backoffTimer = setTimeout(() => {
    s.backoffTimer = null;
    createSession(sessionId, true).catch((e) => {
      s.reconnecting = false;
      logger.error({ sessionId, err: e }, 'reconnect failed');
      scheduleReconnect(sessionId, 'retry-failed');
    });
  }, delay);
}

export async function getSession(sessionId: string): Promise<SessionEntry | null> {
  const s = sessions[sessionId];
  if (s) return s;
  try {
    const restored = await createSession(sessionId, false);
    return restored ?? null;
  } catch (e) {
    logger.error({ sessionId, err: e }, 'lazy restore failed');
    return null;
  }
}

export async function getLastQR(sessionId: string): Promise<string | null> {
  return sessions[sessionId]?.lastQr ?? null;
}

export async function createSession(sessionId: string, force = false): Promise<SessionEntry> {
  const existing = sessions[sessionId];
  if (existing?.sock && existing.status !== 'close' && !force) return existing;

  // Distributed lock to prevent multi-instance collisions
  if (!existing?.lock) {
    const lock = await acquireSessionLock(redis as any, sessionId);
    if (!lock) {
      const err = new Error(`Session ${sessionId} is locked by another instance`);
      (err as any).code = 423;
      throw err;
    }
    sessions[sessionId] = existing
      ? { ...existing, lock }
      : { sock: null, status: 'connecting', lastQr: null, userJid: null, lock };
  }

  if (force && existing?.sock) {
    try {
      existing.sock.ev.removeAllListeners('connection.update');
      existing.sock.ev.removeAllListeners('creds.update');
      existing.sock.ev.removeAllListeners('messages.upsert');
    } catch {}
    const current = sessions[sessionId];
    if (current) {
      current.sock = null;
    }
  }

  const plogger: Logger = P({ level: env.LOG_LEVEL || 'info' });
  const { state, saveCreds } = await useRedisAuth(sessionId, redis as any, plogger);

  const sock = makeWASocket({
    logger: plogger,
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    auth: state,
    keepAliveIntervalMs: 20_000,
    connectTimeoutMs: 60_000,
  });

  const entry: SessionEntry = {
    sock,
    status: 'connecting',
    lastQr: existing?.lastQr ?? null,
    userJid: existing?.userJid ?? null,
    reconnecting: existing?.reconnecting,
    backoffMs: existing?.backoffMs,
    backoffTimer: existing?.backoffTimer,
    lock: existing?.lock,
  };
  sessions[sessionId] = entry;

  sock.ev.on('creds.update', async () => {
    try {
      await saveCreds();
    } catch (e) {
      logger.error({ sessionId, err: e }, 'saveCreds error');
    }
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && entry.status !== 'open' && entry.lastQr !== qr) {
      entry.lastQr = qr;
      (async () => {
        try {
          const qrStr = await QRCode.toString(qr, { type: 'terminal', small: true, margin: 1 });
          console.clear();
          console.log(`[${sessionId}] Scan QR:`);
          process.stdout.write(qrStr + '\n');
        } catch (e) {
          logger.error({ sessionId, err: e }, 'QR render error');
        }
      })();
    }

    if (connection === 'open') {
      entry.status = 'open';
      entry.userJid = sock.user?.id ?? null;
      entry.lastQr = null;
      resetBackoff(entry);
      logger.info({ sessionId, user: entry.userJid }, 'connected');
      return;
    }

    if (connection === 'close') {
      entry.status = 'close';
      entry.lastQr = null;
      const boom = (lastDisconnect as any)?.error;
      const code: number | undefined = boom?.output?.statusCode ?? boom?.code;
      const msg: string | undefined = boom?.message;

      logger.warn({ sessionId, code, msg }, 'connection closed');

      if (code === DisconnectReason.loggedOut || code === DisconnectReason.connectionReplaced) {
        void logoutSession(sessionId);
        return;
      }

      scheduleReconnect(sessionId, msg || `code-${code}`);
    }
  });

  return entry;
}

export async function logoutSession(sessionId: string): Promise<{ ok: boolean }> {
  const s = await getSession(sessionId);
  if (!s) {
    await deleteRedisAuth(sessionId, redis as any);
    return { ok: true };
  }

  try {
    if (s.backoffTimer) clearTimeout(s.backoffTimer);
  } catch {}
  s.reconnecting = false;

  try {
    s.sock?.ev.removeAllListeners('connection.update');
    s.sock?.ev.removeAllListeners('creds.update');
    s.sock?.ev.removeAllListeners('messages.upsert');
  } catch {}

  try {
    await s.sock?.logout();
  } catch {}

  try {
    await s.lock?.release();
  } catch {}

  delete sessions[sessionId];
  await deleteRedisAuth(sessionId, redis as any);
  return { ok: true };
}

function extractIdFromKey(k: string): string | null {
  let m = /^sess:([^:]+):tokens$/.exec(k);
  if (m) return m[1] ?? null;

  m = /^baileys:(.+):creds$/.exec(k);
  if (m) return m[1] ?? null;

  m = /^lock:wa:(.+)$/.exec(k);
  if (m) return m[1] ?? null;

  return null;
}

async function scanKeys(pattern: string): Promise<string[]> {
  let cursor = '0';
  const out: string[] = [];
  do {
    const [next, keys] = (await (redis as any).scan(
      cursor,
      'MATCH',
      pattern,
      'COUNT',
      SCAN_COUNT
    )) as [string, string[]];
    out.push(...(keys as string[]));
    cursor = next;
  } while (cursor !== '0');
  return out;
}

export async function restoreAllSessionsFromRedis(): Promise<string[]> {
  const patterns = ['sess:*:tokens', 'baileys:*:creds'];
  const ids = new Set<string>();

  for (const p of patterns) {
    const keys = await scanKeys(p);
    for (const k of keys) {
      const id = extractIdFromKey(k);
      if (id) ids.add(id);
    }
  }

  const lockedKeys = await scanKeys('lock:wa:*');
  const locked = new Set<string>();
  for (const k of lockedKeys) {
    const m = /^lock:wa:(.+)$/.exec(k);
    if (m && m[1] !== undefined) locked.add(m[1]);
  }

  const restored: string[] = [];

  for (const id of ids) {
    if (locked.has(id)) {
      logger.warn({ id }, 'auto-restore: skip due to lock');
      continue;
    }

    let ok = false;
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      try {
        await createSession(id, false);
        restored.push(id);
        ok = true;
        break;
      } catch (e: any) {
        if (e?.code === 423) {
          if (attempt < RETRIES) {
            await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
            continue;
          }
          logger.warn({ id }, 'auto-restore: locked, skipped after retries');
        } else {
          logger.error({ id, err: e }, 'auto-restore failed');
        }
        break;
      }
    }

    if (!ok) {
      logger.info({ id }, 'auto-restore: not restored');
    }
  }

  logger.info({ count: restored.length, restored: Array.from(restored) }, 'auto-restore complete');
  return restored;
}
