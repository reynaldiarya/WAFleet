import type { WASocket } from 'baileys';

export function sanitizeNumber(raw: string, countryCode?: string) {
  const s = raw.replace(/\D/g, '');
  if (s.startsWith('0') && countryCode && /^\d+$/.test(countryCode)) {
    return countryCode + s.slice(1);
  }
  return s;
}

export function toJid(num: string) {
  return num.includes('@') ? num : `${num}@s.whatsapp.net`;
}

export function parseDelay(spec?: string | number): number {
  if (spec == null) return 0;

  if (typeof spec === 'number') {
    if (!Number.isFinite(spec)) return 0;
    const n = Math.trunc(spec);
    return n > 0 ? n * 1000 : 0;
  }

  const s = spec.trim();
  if (/^\d+$/.test(s)) {
    const n = parseInt(s, 10);
    return n > 0 ? n * 1000 : 0;
  }

  return 0;
}

export async function fetchBuffer(
  url: string
): Promise<{ buffer: Buffer; mimetype?: string; filename?: string }> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Fetch URL gagal: ${r.status}`);
  const ab = await r.arrayBuffer();
  const buffer = Buffer.from(ab);
  const ct = r.headers.get('content-type') || undefined;
  let filename: string | undefined;
  try {
    const u = new URL(url);
    const base = u.pathname.split('/').pop() || undefined;
    if (base && base.length <= 100) filename = base;
  } catch {}
  return { buffer, mimetype: ct, filename };
}

export async function simulateTyping(sock: WASocket, jid: string, ms = 2000) {
  try {
    await sock.sendPresenceUpdate('composing', jid);
    await new Promise((r) => setTimeout(r, ms));
    await sock.sendPresenceUpdate('paused', jid);
  } catch {}
}
