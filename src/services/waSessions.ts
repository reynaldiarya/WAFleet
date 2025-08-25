import { makeWASocket, DisconnectReason, type WASocket } from 'baileys';
import P, { type Logger } from 'pino';
import QRCode from 'qrcode';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { redis } from '../utils/redisClient.js';
import { useRedisAuth, deleteRedisAuth } from './waAuthRedis.js';
import { acquireSessionLock, type SessionLock } from './locks.js';

/**
 * Modul manajer sesi Baileys:
 * - Menyimpan dan mengelola lifecycle koneksi WA Web per `sessionId`
 * - Persist kredensial ke Redis agar bisa restore tanpa scan QR
 * - Menangani reconnect dengan backoff
 * - Mencetak QR ke terminal (opsional) saat pairing
 * - Menggunakan distributed lock agar tidak ada dua proses/instance
 *   yang memproses session yang sama (hindari race condition)
 */

type SessionStatus = 'connecting' | 'open' | 'close';

export interface SessionEntry {
  sock: WASocket | null; // instance socket Baileys
  status: SessionStatus; // status koneksi saat ini
  lastQr: string | null; // cache QR raw (untuk dedup)
  userJid: string | null; // JID user saat sudah login
  reconnecting?: boolean; // flag agar tidak schedule reconnect ganda
  backoffMs?: number; // durasi backoff saat ini
  backoffTimer?: NodeJS.Timeout | null; // timer reconnect
  lock?: SessionLock; // distributed lock untuk sessionId ini
}

const sessions: Record<string, SessionEntry> = {};

// Fallback default kalau env belum ada (nilai batas backoff)
const RECONNECT_MIN = (env as any).WS_RECONNECT_MIN_MS ?? 2_000;
const RECONNECT_MAX = (env as any).WS_RECONNECT_MAX_MS ?? 30_000;
const SCAN_COUNT = (env as any).RESTORE_SCAN_COUNT ?? 200;
const RETRIES = (env as any).RESTORE_LOCK_RETRIES ?? 5;
const RETRY_DELAY_MS = (env as any).RESTORE_LOCK_RETRY_DELAY_MS ?? 2_000;

/** Reset state backoff setelah koneksi berhasil open */
function resetBackoff(s: SessionEntry) {
  s.backoffMs = RECONNECT_MIN;
  if (s.backoffTimer) {
    clearTimeout(s.backoffTimer);
    s.backoffTimer = null;
  }
  s.reconnecting = false;
}

/**
 * Jadwalkan percobaan reconnect dengan exponential backoff.
 * - Tidak akan menjadwalkan ulang jika sudah dalam mode `reconnecting`
 * - Memanggil `createSession(sessionId, true)` agar re-init socket
 */
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

/** Ambil entry session dari memori (null jika belum dibuat) */
export async function getSession(sessionId: string): Promise<SessionEntry | null> {
  const s = sessions[sessionId];
  if (s) return s;
  try {
    const restored = await createSession(sessionId, false); // akan load creds dari Redis jika ada
    return restored ?? null;
  } catch (e) {
    logger.error({ sessionId, err: e }, 'lazy restore failed');
    return null;
  }
}

/** Ambil QR terakhir (raw string) jika ada, untuk endpoint /qr */
export async function getLastQR(sessionId: string): Promise<string | null> {
  return sessions[sessionId]?.lastQr ?? null;
}

/**
 * Buat / restore session:
 * - Jika sudah ada socket aktif & tidak `force`, kembalikan instance yang ada
 * - Acquire distributed lock (agar tidak diproses paralel di multi instance)
 * - Saat `force`, lepas event listener lama dan nul-kan sock agar tidak dobel
 * - Bangun `makeWASocket` dari `useRedisAuth()` (persist di Redis)
 * - Pasang listener `creds.update` → `saveCreds()` dan `connection.update` untuk lifecycle
 */
export async function createSession(sessionId: string, force = false): Promise<SessionEntry> {
  const existing = sessions[sessionId];
  if (existing?.sock && existing.status !== 'close' && !force) return existing;

  // ---- Lock distribusi untuk hindari multi-instance ----
  if (!existing?.lock) {
    const lock = await acquireSessionLock(redis as any, sessionId);
    if (!lock) {
      const err = new Error(`Session ${sessionId} is locked by another instance`);
      (err as any).code = 423; // 423 Locked (HTTP-ish)
      throw err;
    }
    sessions[sessionId] = existing
      ? { ...existing, lock }
      : { sock: null, status: 'connecting', lastQr: null, userJid: null, lock };
  }

  // 🧹 Jika force & ada socket lama → cabut listener dulu supaya tidak dobel
  if (force && existing?.sock) {
    try {
      existing.sock.ev.removeAllListeners('connection.update');
      existing.sock.ev.removeAllListeners('creds.update');
      existing.sock.ev.removeAllListeners('messages.upsert');
    } catch {}
    sessions[sessionId]!.sock = null;
  }

  // Logger khusus untuk Baileys
  const plogger: Logger = P({ level: env.LOG_LEVEL || 'info' });

  // Load/persist kredensial via Redis → ini memungkinkan auto-restore tanpa QR
  const { state, saveCreds } = await useRedisAuth(sessionId, redis as any, plogger);

  // Membuat socket Baileys
  const sock = makeWASocket({
    logger: plogger,
    printQRInTerminal: false, // kita cetak QR manual di handler update
    markOnlineOnConnect: false, // optional: tidak langsung online
    auth: state, // kredensial + signal keystore (Redis)
    keepAliveIntervalMs: 20_000, // ping interval
    connectTimeoutMs: 60_000, // batas waktu menghubungkan
  });

  // Simpan/replace entry di memori
  const entry: SessionEntry = { ...(sessions[sessionId] || {}), sock, status: 'connecting' };
  sessions[sessionId] = entry;

  // Persist cred saat berubah (Baileys memancarkan event ini)
  sock.ev.on('creds.update', async () => {
    try {
      await saveCreds();
    } catch (e) {
      logger.error({ sessionId, err: e }, 'saveCreds error');
    }
  });

  // Lifecycle koneksi
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    // ---- QR: debounce & jangan print kalau sudah open ----
    if (qr && entry.status !== 'open' && entry.lastQr !== qr) {
      entry.lastQr = qr;
      (async () => {
        try {
          // Render QR ke terminal (teks), bukan ke logger agar ANSI tidak di-escape
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
      // Koneksi sukses → reset backoff, bersihkan lastQr, simpan JID user
      entry.status = 'open';
      entry.userJid = sock.user?.id ?? null;
      entry.lastQr = null; // ✅ bersihkan, supaya QR berikutnya tidak ke-dedup salah
      resetBackoff(entry);
      logger.info({ sessionId, user: entry.userJid }, 'connected');
      return;
    }

    if (connection === 'close') {
      // Koneksi tutup → tentukan apakah perlu reconnect atau logout total
      entry.status = 'close';
      entry.lastQr = null; // ✅ agar saat reconnect QR baru dicetak lagi (bukan sisa)
      const boom = (lastDisconnect as any)?.error;
      const code: number | undefined = boom?.output?.statusCode ?? boom?.code;
      const msg: string | undefined = boom?.message;

      logger.warn({ sessionId, code, msg }, 'connection closed');

      // Tidak reconnect untuk loggedOut / connectionReplaced (harus pairing ulang atau sesi digantikan)
      if (code === DisconnectReason.loggedOut || code === DisconnectReason.connectionReplaced) {
        void logoutSession(sessionId); // otomatis wipe & release lock
        return;
      }

      // Reconnect untuk kasus umum (timeout, network issue, dsb.)
      scheduleReconnect(sessionId, msg || `code-${code}`);
    }
  });

  return entry;
}

/**
 * Logout + wipe kredensial (terminate sesi):
 * - Hentikan backoff
 * - Lepas semua listener event dari socket
 * - Panggil `sock.logout()` (abaikan error)
 * - Release distributed lock
 * - Hapus entry dari memori
 * - Hapus seluruh data auth & token di Redis (`deleteRedisAuth`)
 *
 * Catatan:
 * - Fungsi ini idempotent: jika session tidak ada di memori, tetap akan
 *   menghapus kredensial/token di Redis.
 * - Setelah dipanggil, perlu scan QR lagi bila ingin login ulang.
 */
export async function logoutSession(sessionId: string): Promise<{ ok: boolean }> {
  const s = await getSession(sessionId);
  if (!s) {
    await deleteRedisAuth(sessionId, redis as any); // idempotent
    return { ok: true };
  }

  // stop backoff
  try {
    if (s.backoffTimer) clearTimeout(s.backoffTimer);
  } catch {}
  s.reconnecting = false;

  // lepas listener
  try {
    s.sock?.ev.removeAllListeners('connection.update');
    s.sock?.ev.removeAllListeners('creds.update');
    s.sock?.ev.removeAllListeners('messages.upsert');
  } catch {}

  // logout WA Web (abaikan error)
  try {
    await s.sock?.logout();
  } catch {}

  // release lock (supaya instance lain bisa acquire)
  try {
    await s.lock?.release();
  } catch {}

  // hapus dari cache memori
  delete sessions[sessionId];

  // wipe store di Redis (kredensial + token API session)
  await deleteRedisAuth(sessionId, redis as any);
  return { ok: true };
}

/**
 * Auto-restore semua session yang punya kredensial Baileys di Redis.
 *
 * - Men-scan key `baileys:*:creds` (COUNT 200) untuk menemukan sessionId.
 * - Untuk tiap sessionId: panggil `createSession(id, false)` agar socket aktif lagi tanpa QR.
 * - Jika terkendala lock (423), lakukan retry singkat beberapa kali, lalu skip bila tetap locked.
 * - Mengembalikan daftar sessionId yang berhasil direstore (triggered).
 *
 * Catatan:
 * - 423 "Locked" biasanya terjadi saat dua proses overlap (mis. tsx watch restart) atau ada
 *   pemanggilan paralel. Ini normal; kita tidak treat sebagai error fatal.
 * - COUNT 200 adalah hint jumlah key per iterasi SCAN (bukan batas keras).
 */
function extractIdFromKey(k: string): string | null {
  // sess:<id>:tokens
  let m = /^sess:([^:]+):tokens$/.exec(k);
  if (m) return m[1];

  // baileys:<id>:creds
  m = /^baileys:(.+):creds$/.exec(k);
  if (m) return m[1];

  // fallback opsional (jika ingin cut from lock)
  m = /^lock:wa:(.+)$/.exec(k);
  if (m) return m[1];

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
  // 1) Kumpulkan semua kandidat ID dari berbagai pola yang kita pakai
  const patterns = ['sess:*:tokens', 'baileys:*:creds'];
  const ids = new Set<string>();

  for (const p of patterns) {
    const keys = await scanKeys(p);
    for (const k of keys) {
      const id = extractIdFromKey(k);
      if (id) ids.add(id);
    }
  }

  // (opsional) deteksi lock yg masih aktif agar bisa di-skip
  const lockedKeys = await scanKeys('lock:wa:*');
  const locked = new Set<string>();
  for (const k of lockedKeys) {
    const m = /^lock:wa:(.+)$/.exec(k);
    if (m) locked.add(m[1]);
  }

  const restored: string[] = [];

  for (const id of ids) {
    // skip yang sedang locked oleh instance lain
    if (locked.has(id)) {
      logger.warn({ id }, 'auto-restore: skip karena locked');
      continue;
    }

    let ok = false;
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      try {
        await createSession(id, false); // pakai creds/tokens dari Redis (tanpa QR)
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
