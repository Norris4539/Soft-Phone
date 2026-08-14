/**
 * Password verification.
 *
 * The encoding is produced by scripts/manage-users.mjs; the two must stay in
 * step.  scrypt rather than bcrypt so neither the server image nor the
 * provisioning script needs a native module.
 *
 *   scrypt$<N>$<r>$<p>$<base64 salt>$<base64 hash>
 */

import { scrypt, timingSafeEqual } from 'node:crypto';

const MAX_MEM = 64 * 1024 * 1024;

function derive(plain: string, salt: Buffer, keylen: number, N: number, r: number, p: number) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(plain, salt, keylen, { N, r, p, maxmem: MAX_MEM }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];

  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  const expected = Buffer.from(hashRaw, 'base64');
  if (expected.length === 0) return false;

  try {
    const actual = await derive(plain, Buffer.from(saltRaw, 'base64'), expected.length, N, r, p);
    return timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}
