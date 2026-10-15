/**
 * FR-DOC-010 share-link tokens: 256 random bits, URL-safe. Only the SHA-256 is stored, so a
 * database dump does not contain usable links; comparison is constant-time.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function generateShareToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashShareToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function tokenMatches(token: string, storedHash: string): boolean {
  if (!token) return false;
  const a = Buffer.from(hashShareToken(token), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
