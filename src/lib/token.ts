import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { prisma } from '../db';

export interface TokenPayload {
  userId: string;
  email: string;
}

/**
 * Sign a short-lived access token (stateless, not stored server-side).
 */
export function signAccessToken(payload: TokenPayload): string {
  return jwt.sign(payload, config.jwt.secret, {
    expiresIn: config.jwt.accessExpiresIn as any,
  });
}

/**
 * Verify and decode an access token.
 */
export function verifyAccessToken(token: string): TokenPayload {
  return jwt.verify(token, config.jwt.secret) as TokenPayload;
}

/**
 * Create a refresh token (opaque UUID) stored in the DB.
 * Returns the raw token string to set as an httpOnly cookie.
 */
export async function createRefreshToken(userId: string): Promise<string> {
  const token = crypto.randomUUID();

  // Parse expiry duration (e.g. "7d") to milliseconds
  const expiresInMs = parseDuration(config.jwt.refreshExpiresIn);
  const expiresAt = new Date(Date.now() + expiresInMs);

  await prisma.refreshToken.create({
    data: { token, userId, expiresAt },
  });

  return token;
}

/**
 * Verify a refresh token — checks it exists, is not expired, and returns the userId.
 * Deletes the token from DB on successful verification (single-use rotation).
 */
export async function consumeRefreshToken(token: string): Promise<string> {
  const stored = await prisma.refreshToken.findUnique({
    where: { token },
  });

  if (!stored) {
    throw new Error('Refresh token not found');
  }

  if (stored.expiresAt < new Date()) {
    await prisma.refreshToken.delete({ where: { id: stored.id } });
    throw new Error('Refresh token expired');
  }

  // Delete old token (rotation — single use)
  await prisma.refreshToken.delete({ where: { id: stored.id } });

  return stored.userId;
}

/**
 * Revoke (delete) a specific refresh token.
 */
export async function revokeRefreshToken(token: string): Promise<void> {
  await prisma.refreshToken.deleteMany({ where: { token } });
}

/**
 * Revoke all refresh tokens for a user (e.g. password change).
 */
export async function revokeAllUserRefreshTokens(userId: string): Promise<void> {
  await prisma.refreshToken.deleteMany({ where: { userId } });
}

/**
 * Parse a duration string like "15m", "7d", "1h" into milliseconds.
 */
function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+)([smhd])$/);
  if (!match) return 7 * 24 * 60 * 60 * 1000; // default 7d

  const value = parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case 's': return value * 1000;
    case 'm': return value * 60 * 1000;
    case 'h': return value * 60 * 60 * 1000;
    case 'd': return value * 24 * 60 * 60 * 1000;
    default: return 7 * 24 * 60 * 60 * 1000;
  }
}
