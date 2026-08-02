import { createHash } from 'node:crypto';

/** SHA-1 hex digest of a UTF-8 string. */
export function sha1Hex(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex');
}

/** SHA-256 hex digest of a UTF-8 string or byte buffer. */
export function sha256Hex(data: string | Uint8Array): string {
  const hash = createHash('sha256');
  if (typeof data === 'string') hash.update(data, 'utf8');
  else hash.update(data);
  return hash.digest('hex');
}

/** Short (12-char) SHA-1 digest, used for content-addressed cache filenames. */
export function shortHash(text: string): string {
  return sha1Hex(text).slice(0, 12);
}
