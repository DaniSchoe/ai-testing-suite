// Verschlüsselung von Secrets (API-Keys, Persona-Passwörter) im Ruhezustand.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { config } from './config.js';

const key = createHash('sha256').update(`secrets:${config.appSecret}`).digest();

export function encrypt(plain) {
  if (plain === undefined || plain === null || plain === '') return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

export function decrypt(blob) {
  if (!blob) return null;
  const [version, iv, tag, data] = blob.split(':');
  if (version !== 'v1') throw new Error('Unbekanntes Secret-Format');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

// Für die Anzeige im Admin-Panel: nur die letzten Zeichen zeigen.
export function mask(blob) {
  const plain = decrypt(blob);
  if (!plain) return null;
  return plain.length <= 6 ? '••••' : `••••${plain.slice(-4)}`;
}
