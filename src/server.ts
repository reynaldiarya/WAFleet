import express, { type Request, type Response, type NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import QRCode from 'qrcode';
import * as pinoHttpMod from 'pino-http';
const pinoHttp = (pinoHttpMod as any).default ?? (pinoHttpMod as any); // ESM/CJS compatibility
import { env } from './config/env.js';
import { logger } from './utils/logger.js';
import { redis } from './utils/redisClient.js';
import { requireAuthToken } from './utils/requireAuthToken.js';
import { createSessionTokenPair } from './services/tokenStore.js';
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

app.use(pinoHttp({ logger }));
app.use(helmet());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const origins =
  env.ALLOWED_ORIGINS === '*' ? undefined : env.ALLOWED_ORIGINS.split(',').map((s) => s.trim());
app.use(
  cors({
    origin: origins || '*',
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

app.use(
  rateLimit({
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    max: env.RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

app.get('/health', requireAuthToken, (_: Request, res: Response) => res.json({ ok: true }));

app.post('/session', async (_: Request, res: Response, next: NextFunction) => {
  try {
    const { id, token } = await createSessionTokenPair();
    await createSession(id, false);

    // Duplicate write maintained for compatibility
    await redis.set(`token:${token}`, id);

    res.json({ success: true, id, token, message: `Session ${id} dibuat.` });
  } catch (e) {
    next(e);
  }
});

app.get('/session', requireAuthToken, async (req: Request, res: Response) => {
  const id = (req as any).sessionId as string;
  const s = await getSession(id);
  if (!s) return res.status(404).json({ error: 'Session tidak ditemukan' });
  res.json({ id, status: s.status, userJid: s.userJid });
});

app.get('/qr', requireAuthToken, async (req: Request, res: Response) => {
  const id = (req as any).sessionId as string;
  const qr = await getLastQR(id);
  if (!qr) return res.status(404).json({ error: 'QR belum tersedia / session belum siap' });

  try {
    if (req.query.image === '1') {
      res.setHeader('Content-Type', 'image/png');
      return QRCode.toFileStream(res, qr);
    }

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

const SendSchema = z.object({
  to: z.string().min(5),
  text: z.string().min(1).optional(),
  location: z.string().optional(),
  url: z.string().url().optional(),
  filename: z.string().max(120).optional(),
  delay: z.union([z.number(), z.string()]).optional(),
  typing: z.coerce.boolean().optional(),
  choices: z.string().optional(),
  select: z.enum(['single', 'multiple']).optional(),
  pollname: z.string().optional(),
});

app.post(
  '/send',
  requireAuthToken,
  upload.single('file'),
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

      let payload: any | null = null;

      // 1. Poll Message
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

      // 2. Location Message
      if (!payload && location) {
        const parts = location.split(',').map((x) => x.trim());
        if (parts.length >= 2) {
          const lat = Number(parts[0]);
          const lon = Number(parts[1]);
          if (Number.isFinite(lat) && Number.isFinite(lon)) {
            payload = { location: { degreesLatitude: lat, degreesLongitude: lon } };
          }
        }
      }

      // 3. Media Message (URL or upload)
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
          payload = { audio: buf, mimetype };
        } else {
          payload = {
            document: buf,
            mimetype: mimetype || 'application/octet-stream',
            fileName: name,
          };
          if (text) payload.caption = text;
        }
      }

      // 4. Text Message (fallback)
      if (!payload) {
        if (!text)
          return res.status(400).json({
            error:
              'Tidak ada payload yang bisa dikirim (butuh text/url/file/location/poll/buttons/template/list)',
          });
        payload = { text };
      }

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

app.post('/logout', requireAuthToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = (req as any).sessionId as string;
    const r = await logoutSession(id);
    res.json({ success: true, ...r });
  } catch (e) {
    next(e);
  }
});

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  const status = typeof err?.code === 'number' ? err.code : 500;
  logger.error({ err }, 'unhandled error');
  res.status(status).json({ error: err?.message || 'Internal Server Error' });
});

app.set('trust proxy', true);
const server = app.listen(env.PORT, () => {
  logger.info(`API listening on :${env.PORT}`);
});

setTimeout(async () => {
  try {
    const ids = await restoreAllSessionsFromRedis();
    logger.info({ count: ids.length }, 'auto-restore complete');
  } catch (e) {
    logger.error({ err: e }, 'auto-restore error');
  }
}, env.AUTO_RESTORE_STARTUP_DELAY_MS);

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
