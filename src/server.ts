import express, { type Request, type Response, type NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import QRCode from 'qrcode';
import * as pinoHttpMod from 'pino-http';
const pinoHttp = (pinoHttpMod as any).default ?? (pinoHttpMod as any); // kompatibel ESM/CJS untuk pino-http
import { env } from './config/env.js';
import { logger } from './utils/logger.js';
import { redis } from './utils/redisClient.js';
import { requireAuthToken } from './utils/requireAuthToken.js'; // middleware: baca Authorization: Bearer <token> → set req.sessionId
import { createSessionTokenPair } from './services/tokenStore.js'; // generate {id, token} + simpan mapping token→sessionId di Redis
import {
  createSession,
  getSession,
  getLastQR,
  logoutSession,
  restoreAllSessionsFromRedis,
} from './services/waSessions.js';
import { z } from 'zod';
import multer from 'multer';
import { parseDelay, toJid, fetchBuffer, simulateTyping } from './utils/sendHelpers.js';

const app = express();

// logging http (request/response) dengan pino
app.use(pinoHttp({ logger }));

// hardening header + parser body json/urlencoded
app.use(helmet());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } }); // 25MB

// CORS
// Jika ALLOWED_ORIGINS='*' → izinkan semua origin.
// Jika tidak, pecah dengan koma → whitelist array.
const origins =
  env.ALLOWED_ORIGINS === '*' ? undefined : env.ALLOWED_ORIGINS.split(',').map((s) => s.trim());
app.use(
  cors({
    origin: origins || '*',
    methods: ['GET', 'POST'], // tambahkan method lain bila perlu (mis. 'DELETE' jika ada endpoint delete)
    allowedHeaders: ['Content-Type', 'Authorization'], // pastikan Authorization diperbolehkan untuk Bearer token
  })
);

// Rate limit global (per IP) untuk menghindari spam/abuse
app.use(
  rateLimit({
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    max: env.RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// health check sederhana
app.get('/health', requireAuthToken, (_: Request, res: Response) => res.json({ ok: true }));

// Buat session baru: auto-generate id + token
app.post('/session', async (_: Request, res: Response, next: NextFunction) => {
  try {
    // generate id unik + token, dan simpan mapping token->sessionId (serta daftar token per session)
    const { id, token } = await createSessionTokenPair();

    // buat koneksi Baileys untuk session baru (force = false karena id baru)
    await createSession(id, false);

    // NOTE: createSessionTokenPair() SUDAH memanggil redis.set(token:<token>) dan SADD sess:<id>:tokens
    // Baris di bawah ini sebenarnya redundant/duplikat; dipertahankan agar tidak mengubah perilaku, tapi aman dihapus.
    await redis.set(`token:${token}`, id);

    // kembalikan id & token ke klien
    // (opsional: gunakan res.status(201) untuk kode "Created")
    res.json({ success: true, id, token, message: `Session ${id} dibuat.` });
  } catch (e) {
    next(e);
  }
});

// Ambil info session berdasarkan Bearer token (tanpa :id di URL)
app.get('/session', requireAuthToken, async (req: Request, res: Response) => {
  const id = (req as any).sessionId as string;
  const s = await getSession(id);
  if (!s) return res.status(404).json({ error: 'Session tidak ditemukan' });
  res.json({ id, status: s.status, userJid: s.userJid });
});

// Ambil QR terakhir (jika tersedia) untuk proses pairing
app.get('/qr', requireAuthToken, async (req: Request, res: Response) => {
  const id = (req as any).sessionId as string;
  const qr = await getLastQR(id);
  if (!qr) return res.status(404).json({ error: 'QR belum tersedia / session belum siap' });

  try {
    if (req.query.image === '1') {
      // Output langsung PNG
      res.setHeader('Content-Type', 'image/png');
      return QRCode.toFileStream(res, qr); // stream langsung ke response
    }

    // Default → Base64 string di JSON
    const qrBase64 = await QRCode.toDataURL(qr);
    return res.json({
      sessionId: id,
      qr: qrBase64,
    });
  } catch (err) {
    console.error('QR encode error:', err);
    return res.status(500).json({ error: 'Gagal generate QR' });
  }
});

// Kirim pesan teks
const SendSchema = z.object({
  to: z.string().min(5),

  // pesan teks (opsional, bisa jadi caption utk media)
  text: z.string().min(1).optional(),

  // lokasi: "lat,lon"
  location: z.string().optional(),

  // media via URL atau upload file
  url: z.string().url().optional(),
  filename: z.string().max(120).optional(),

  // delay: detik, "10", "10 s", atau "1-10"
  delay: z.union([z.number(), z.string()]).optional(),

  // typing: simulasi mengetik
  typing: z.coerce.boolean().optional(),

  // Poll
  choices: z.string().optional(), // "satu,dua,tiga"
  select: z.enum(['single', 'multiple']).optional(),
  pollname: z.string().optional(),
});

app.post(
  '/send',
  requireAuthToken,
  upload.single('file'), // dukung multipart/form-data (field: file)
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = (req as any).sessionId as string;
      const s = await getSession(id);
      if (!s || !s.sock)
        return res.status(404).json({ error: 'Session tidak ditemukan / belum siap' });
      if (s.status !== 'open')
        return res.status(409).json({ error: `Session belum open (status: ${s.status})` });

      const parsed = SendSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

      const { to, text, location, url, filename, delay, typing, choices, select, pollname } =
        parsed.data;
      const jid = toJid(to);

      // Bangun payload sesuai prioritas:
      // 1) POLL
      let payload: any | null = null;
      if (choices && pollname) {
        const values = choices
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        if (values.length >= 2) {
          const selectableCount = select === 'multiple' ? Math.min(12, values.length) : 1;
          payload = { poll: { name: pollname, values, selectableCount } };
        }
      }

      // 2) LOCATION
      if (!payload && location) {
        const parts = location.split(',').map((x) => x.trim());
        if (parts.length >= 2) {
          const lat = Number(parts[0]),
            lon = Number(parts[1]);
          if (Number.isFinite(lat) && Number.isFinite(lon)) {
            payload = { location: { degreesLatitude: lat, degreesLongitude: lon } };
          }
        }
      }

      // 3) MEDIA (URL atau file upload)
      if (!payload && (req.file || url)) {
        let buf: Buffer, mimetype: string | undefined, name: string | undefined;
        if (req.file) {
          buf = req.file.buffer;
          mimetype = req.file.mimetype;
          name = filename || req.file.originalname;
        } else {
          const fetched = await fetchBuffer(url!);
          buf = fetched.buffer;
          mimetype = fetched.mimetype;
          name = filename || fetched.filename || 'file';
        }

        if (mimetype?.startsWith('image/')) {
          payload = { image: buf, mimetype, caption: text };
        } else if (mimetype?.startsWith('video/')) {
          payload = { video: buf, mimetype, caption: text };
        } else if (mimetype?.startsWith('audio/')) {
          payload = { audio: buf, mimetype }; // tambahkan ptt: true kalau ingin voice note
        } else {
          payload = {
            document: buf,
            mimetype: mimetype || 'application/octet-stream',
            fileName: name,
          };
          if (text) payload.caption = text;
        }
      }

      // 4) TEXT (fallback)
      if (!payload) {
        if (!text)
          return res.status(400).json({
            error:
              'Tidak ada payload yang bisa dikirim (butuh text/url/file/location/poll/buttons/template/list)',
          });
        payload = { text };
      }

      // Delay & typing
      const delayMs = parseDelay(delay);
      let sentMsg;

      if (typing) {
        try {
          simulateTyping(s.sock!, jid, 2000);
        } catch {}
      }

      if (delayMs && delayMs > 0) {
        setTimeout(async () => {
          try {
            sentMsg = await s.sock!.sendMessage(jid, payload);
          } catch (err) {
            logger.error({ err }, 'send /send failed');
          }
        }, delayMs);

        res.json({ success: true, detail: { status: 'pending' }, scheduledInMs: delayMs });
      } else {
        try {
          sentMsg = await s.sock!.sendMessage(jid, payload);
        } catch (err) {
          logger.error({ err }, 'send /send failed');
        }
        res.json({ success: true, detail: sentMsg, scheduledInMs: delayMs });
      }
    } catch (e) {
      next(e);
    }
  }
);

// Logout/terminate session (akan menghapus kredensial Baileys dan REVOKE semua token API session tsb)
app.post('/logout', requireAuthToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = (req as any).sessionId as string;
    const r = await logoutSession(id);
    res.json({ success: true, ...r });
  } catch (e) {
    next(e);
  }
});

// error handler (terakhir)
// - Jika ada err.code numerik (mis. 423 dari createSession saat lock) → pakai sebagai HTTP status
// - Jika tidak, fallback 500 Internal Server Error
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  const status = typeof err?.code === 'number' ? err.code : 500;
  logger.error({ err }, 'unhandled error');
  res.status(status).json({ error: err?.message || 'Internal Server Error' });
});

// start server
app.set('trust proxy', true); // opsional: jika di belakang reverse proxy (nginx, cloud), agar rate-limit/IP akurat
const server = app.listen(env.PORT, () => {
  logger.info(`API listening on :${env.PORT}`);
});

// kick off auto-restore non-blocking
setTimeout(async () => {
  try {
    const ids = await restoreAllSessionsFromRedis();
    logger.info({ count: ids.length }, 'auto-restore complete');
  } catch (e) {
    logger.error({ err: e }, 'auto-restore error');
  }
}, env.AUTO_RESTORE_STARTUP_DELAY_MS);

// Graceful shutdown (tidak logout session agar kredensial tetap persisten)
// - Tutup HTTP server (stop terima koneksi baru)
// - Quit Redis (lepas resource)
// - Exit proses
function shutdown(signal: 'SIGINT' | 'SIGTERM') {
  logger.warn({ signal }, 'shutting down');
  server.close(() => {
    (async () => {
      try {
        try {
          await redis.quit();
        } catch (e) {
          logger.error({ err: e }, 'redis quit error');
        }
      } finally {
        process.exit(0);
      }
    })();
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
