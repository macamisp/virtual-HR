/**
 * JWT issuance and verification shared by the HTTP guard and the WebSocket gateway.
 * Access tokens and MFA-enrollment tokens use distinct audiences so an enrollment
 * token can never be accepted where a full access token is required (FR-AUTH-004).
 */
import jwt from 'jsonwebtoken';
import { getJwtSecret } from '../common/config.ts';
import type { JwtPayload, TokenType } from '../../../../packages/shared/src/index.ts';

const ISSUER = 'hrvo-api';
const AUDIENCE: Record<TokenType, string> = {
  access: 'hrvo-api',
  mfa_enroll: 'hrvo-mfa-enroll',
};

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60; // FR-AUTH-003
export const MFA_ENROLL_TOKEN_TTL_SECONDS = 10 * 60;

type Claims = Omit<JwtPayload, 'exp'>;

export function signAccessToken(claims: Claims & { sid: string }, ttlSeconds: number = ACCESS_TOKEN_TTL_SECONDS): string {
  return jwt.sign(claims, getJwtSecret(), {
    expiresIn: ttlSeconds,
    issuer: ISSUER,
    audience: AUDIENCE.access,
    algorithm: 'HS256',
  });
}

export function signMfaEnrollmentToken(claims: Omit<Claims, 'sid'>): string {
  return jwt.sign(claims, getJwtSecret(), {
    expiresIn: MFA_ENROLL_TOKEN_TTL_SECONDS,
    issuer: ISSUER,
    audience: AUDIENCE.mfa_enroll,
    algorithm: 'HS256',
  });
}

export interface VerifiedToken {
  payload: JwtPayload;
  tokenType: TokenType;
}

/** Throws if the token is invalid, expired, or of a type not in `allowed`. */
export function verifyToken(token: string, allowed: readonly TokenType[] = ['access']): VerifiedToken {
  const decoded = jwt.verify(token, getJwtSecret(), {
    issuer: ISSUER,
    audience: allowed.map((t) => AUDIENCE[t]) as [string, ...string[]],
    algorithms: ['HS256'],
  });
  if (typeof decoded === 'string' || !decoded.sub || typeof decoded.orgId !== 'string') {
    throw new Error('Malformed token payload');
  }
  const aud = Array.isArray(decoded.aud) ? decoded.aud[0] : decoded.aud;
  const tokenType: TokenType = aud === AUDIENCE.mfa_enroll ? 'mfa_enroll' : 'access';
  if (tokenType === 'access' && typeof decoded.sid !== 'string') {
    throw new Error('Access token missing session id');
  }
  return { payload: decoded as unknown as JwtPayload, tokenType };
}
