import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import { getSessionIdByToken } from '../services/tokenStore.js';

function parseBearer(auth?: string): string | null {
  if (!auth) return null;
  if (auth.length > env.AUTH_TOKEN_LEN + 7) {
    throw new Error('Input too long');
  }
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7).trim();
  return token || null;
}

const TokenSchema = z.string().min(10).max(512);

export async function requireAuthToken(req: Request, res: Response, next: NextFunction) {
  const token = parseBearer(req.headers.authorization);
  if (!token) return res.status(401).json({ error: 'Authorization: Bearer <token> wajib' });

  const parsed = TokenSchema.safeParse(token);
  if (!parsed.success) return res.status(400).json({ error: 'Token tidak valid' });

  const sessionId = await getSessionIdByToken(token);
  if (!sessionId) return res.status(401).json({ error: 'Token tidak dikenali' });

  (req as any).sessionId = sessionId;
  (req as any).token = token;

  next();
}
