/** JWT issuing and the middleware that guards the API. */

import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';

import { config } from './config.js';
import { findUser, type User } from './users.js';

export interface TokenClaims {
  sub: string;
  name: string;
  role: 'agent' | 'admin';
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

export function issueToken(user: User): string {
  const claims: TokenClaims = { sub: user.extension, name: user.name, role: user.role };
  return jwt.sign(claims, config.jwt.secret, {
    expiresIn: config.jwt.ttl as jwt.SignOptions['expiresIn'],
    issuer: 'softphone-switchboard',
  });
}

export function verifyToken(token: string): TokenClaims | null {
  try {
    return jwt.verify(token, config.jwt.secret, {
      issuer: 'softphone-switchboard',
    }) as TokenClaims;
  } catch {
    return null;
  }
}

/**
 * Resolve a token to the *current* user record rather than trusting the
 * claims: a role change or a removed extension then takes effect immediately
 * instead of at token expiry.
 */
export function userFromToken(token: string): User | null {
  const claims = verifyToken(token);
  if (!claims) return null;
  return findUser(claims.sub) ?? null;
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization ?? '';
  const [scheme, token] = header.split(' ');

  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    res.status(401).json({ error: 'missing bearer token' });
    return;
  }

  const user = userFromToken(token);
  if (!user) {
    res.status(401).json({ error: 'invalid or expired token' });
    return;
  }

  req.user = user;
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.user?.role !== 'admin') {
    res.status(403).json({ error: 'admin role required' });
    return;
  }
  next();
}
