import crypto from 'crypto';
import type { AdapterCredentials } from './tenantConfig.js';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES  = 12;
const TAG_BYTES = 16;

function getKey(): Buffer {
  const hex = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (!hex) throw new Error('[CRYPTO] CREDENTIAL_ENCRYPTION_KEY is not set');
  const buf = Buffer.from(hex, 'hex');
  if (buf.byteLength !== 32) {
    throw new Error('[CRYPTO] CREDENTIAL_ENCRYPTION_KEY must be 32 bytes (64 hex chars)');
  }
  return buf;
}

export interface EncryptedBlob {
  ciphertext: string; // hex
  iv: string;         // hex
}

export function encryptCredentials(credentials: AdapterCredentials): EncryptedBlob {
  const key       = getKey();
  const iv        = crypto.randomBytes(IV_BYTES);
  const cipher    = crypto.createCipheriv(ALGORITHM, key, iv) as crypto.CipherGCM;
  const plaintext = Buffer.from(JSON.stringify(credentials), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag       = cipher.getAuthTag();
  // Append auth tag to ciphertext so decryption can verify integrity
  return {
    ciphertext: Buffer.concat([encrypted, tag]).toString('hex'),
    iv:         iv.toString('hex'),
  };
}

export function decryptCredentials(blob: EncryptedBlob): AdapterCredentials {
  const key        = getKey();
  const iv         = Buffer.from(blob.iv, 'hex');
  const raw        = Buffer.from(blob.ciphertext, 'hex');
  const tag        = raw.subarray(raw.byteLength - TAG_BYTES);
  const ciphertext = raw.subarray(0, raw.byteLength - TAG_BYTES);
  const decipher   = crypto.createDecipheriv(ALGORITHM, key, iv) as crypto.DecipherGCM;
  decipher.setAuthTag(tag);
  const decrypted  = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8')) as AdapterCredentials;
}
