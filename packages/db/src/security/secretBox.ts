import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM for small secrets at rest (MFA seeds now; exchange key references later
 * move to managed key protection per OPS-01). Format: v1.<iv>.<tag>.<ciphertext> (base64url).
 */

let warned = false;

function key(): Buffer {
  const raw = process.env.DATA_ENCRYPTION_KEY;
  if (raw) {
    const k = Buffer.from(raw, 'base64');
    if (k.length !== 32) throw new Error('DATA_ENCRYPTION_KEY must be 32 bytes, base64-encoded.');
    return k;
  }
  if (process.env.NODE_ENV === 'production') throw new Error('DATA_ENCRYPTION_KEY is required in production.');
  if (!warned) {
    warned = true;
    console.warn('[security] DATA_ENCRYPTION_KEY not set: using an insecure development-only key.');
  }
  return createHash('sha256').update('trendpilot-insecure-development-key').digest();
}

export function seal(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export function open(sealed: string): string {
  const [v, iv, tag, ct] = sealed.split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Unsupported sealed value.');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}
