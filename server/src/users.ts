/**
 * The user store.
 *
 * config/users.json is written by scripts/manage-users.mjs and mounted
 * read-only into this container.  It is watched rather than read once, so that
 * adding an extension does not require restarting the server — only an
 * Asterisk reload.
 */

import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import { config } from './config.js';
import { log } from './logger.js';
import { verifyPassword } from './password.js';

export interface QueueMembership {
  name: string;
  penalty: number;
}

export interface User {
  extension: string;
  name: string;
  role: 'agent' | 'admin';
  groups: string[];
  queues: QueueMembership[];
  email?: string;
  did?: string;
  outboundCallerId?: string;
  /** scrypt hash — never leaves this module. */
  password: string;
  /** SIP digest secret. Handed to the owning user's browser, nobody else's. */
  sipPassword: string;
  voicemailPin?: string;
}

export interface RingGroup {
  description?: string;
  strategy?: string;
  timeout?: number;
}

export interface QueueDefinition {
  description?: string;
  strategy?: string;
  timeout?: number;
}

interface UserDatabase {
  users: User[];
  ringGroups: Record<string, RingGroup>;
  queues: Record<string, QueueDefinition>;
}

/** What the rest of the app is allowed to see: no secrets. */
export type PublicUser = Pick<User, 'extension' | 'name' | 'role' | 'groups' | 'queues'> & {
  email?: string;
  did?: string;
};

const usersPath = resolve(config.usersFile);

let db: UserDatabase = { users: [], ringGroups: {}, queues: {} };
let lastModified = 0;

export function toPublicUser(user: User): PublicUser {
  return {
    extension: user.extension,
    name: user.name,
    role: user.role,
    groups: user.groups ?? [],
    queues: user.queues ?? [],
    ...(user.email ? { email: user.email } : {}),
    ...(user.did ? { did: user.did } : {}),
  };
}

async function read(): Promise<UserDatabase> {
  const raw = await readFile(usersPath, 'utf8');
  const parsed = JSON.parse(raw) as Partial<UserDatabase>;

  const users = (parsed.users ?? []).map((user) => ({
    ...user,
    extension: String(user.extension),
    role: user.role === 'admin' ? ('admin' as const) : ('agent' as const),
    groups: user.groups ?? [],
    // Queue membership is accepted as "support" or {name, penalty}; penalty
    // defaults to 0 so every member is offered calls equally.
    queues: (user.queues ?? []).map((q: string | Partial<QueueMembership>) =>
      typeof q === 'string'
        ? { name: q, penalty: 0 }
        : { name: String(q.name), penalty: q.penalty ?? 0 },
    ),
  }));

  return {
    users,
    ringGroups: parsed.ringGroups ?? {},
    queues: parsed.queues ?? {},
  };
}

export async function loadUsers(): Promise<void> {
  try {
    const info = await stat(usersPath);
    db = await read();
    lastModified = info.mtimeMs;

    const unhashed = db.users.filter((u) => !u.password?.startsWith('scrypt$'));
    if (unhashed.length > 0) {
      // Refusing to start would be worse — the operator would lose the
      // dashboard too — but these accounts genuinely cannot log in.
      log.warn('users have unhashed passwords and cannot log in; run: npm run users:apply', {
        extensions: unhashed.map((u) => u.extension),
      });
    }

    log.info('loaded users', { count: db.users.length, path: usersPath });
  } catch (err) {
    log.error('failed to load users', { path: usersPath, error: String(err) });
    throw err;
  }
}

/**
 * Re-read when the file changes on disk.  fs.watch is unreliable across the
 * bind mounts this runs on (it misses events on some Docker Desktop setups),
 * so this polls a stat instead — cheap, and the file is tiny.
 */
export function watchUsers(intervalMs = 5000): NodeJS.Timeout {
  const timer = setInterval(() => {
    void (async () => {
      try {
        const info = await stat(usersPath);
        if (info.mtimeMs === lastModified) return;
        db = await read();
        lastModified = info.mtimeMs;
        log.info('users file changed; reloaded', { count: db.users.length });
      } catch (err) {
        log.warn('could not reload users file', { error: String(err) });
      }
    })();
  }, intervalMs);

  timer.unref();
  return timer;
}

export function findUser(extension: string): User | undefined {
  return db.users.find((u) => u.extension === extension);
}

export function listUsers(): PublicUser[] {
  return db.users.map(toPublicUser);
}

export function listRingGroups(): Record<string, RingGroup> {
  return db.ringGroups;
}

export function listQueues(): Record<string, QueueDefinition> {
  return db.queues;
}

/**
 * Verify a login.  Always runs the KDF, even for an unknown extension, so the
 * response time does not reveal which extensions exist.
 */
export async function authenticate(extension: string, password: string): Promise<User | null> {
  const user = findUser(extension);
  const hash =
    user?.password ??
    // A syntactically valid hash of a value nothing will match.
    'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

  const ok = await verifyPassword(password, hash);
  return ok && user ? user : null;
}

/**
 * The SIP credentials a browser needs to register.  There is no way around
 * giving these to the client — the browser is the SIP endpoint — so they are
 * scoped to exactly one extension and only ever returned to a token holder
 * for that extension.
 */
export function sipCredentialsFor(user: User) {
  return {
    extension: user.extension,
    username: user.extension,
    password: user.sipPassword,
    displayName: user.name,
  };
}
