import { Router } from 'express';

import { issueToken, requireAuth } from '../auth.js';
import { log } from '../logger.js';
import { authenticate, toPublicUser } from '../users.js';

export const authRouter = Router();

/**
 * Rate limiting, kept deliberately simple: a per-extension counter with a
 * sliding window.  This runs behind the company's own network with a handful
 * of users, so an in-memory counter is proportionate — swap in a shared store
 * if you ever run more than one instance.
 */
const attempts = new Map<string, { count: number; firstAt: number }>();
const WINDOW_MS = 5 * 60_000;
const MAX_ATTEMPTS = 10;

function tooManyAttempts(key: string): boolean {
  const entry = attempts.get(key);
  if (!entry) return false;
  if (Date.now() - entry.firstAt > WINDOW_MS) {
    attempts.delete(key);
    return false;
  }
  return entry.count >= MAX_ATTEMPTS;
}

function recordFailure(key: string): void {
  const entry = attempts.get(key);
  if (!entry || Date.now() - entry.firstAt > WINDOW_MS) {
    attempts.set(key, { count: 1, firstAt: Date.now() });
    return;
  }
  entry.count += 1;
}

authRouter.post('/login', async (req, res) => {
  const extension = String(req.body?.extension ?? '').trim();
  const password = String(req.body?.password ?? '');

  if (!extension || !password) {
    res.status(400).json({ error: 'extension and password are required' });
    return;
  }

  if (tooManyAttempts(extension)) {
    log.warn('login throttled', { extension });
    res.status(429).json({ error: 'too many attempts; try again in a few minutes' });
    return;
  }

  const user = await authenticate(extension, password);
  if (!user) {
    recordFailure(extension);
    log.warn('login failed', { extension });
    // Deliberately vague: do not confirm whether the extension exists.
    res.status(401).json({ error: 'invalid extension or password' });
    return;
  }

  attempts.delete(extension);
  log.info('login', { extension, role: user.role });

  res.json({ token: issueToken(user), user: toPublicUser(user) });
});

authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: toPublicUser(req.user!) });
});
