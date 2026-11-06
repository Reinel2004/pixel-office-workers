// Application login for Connected Mode: scrypt password hashes from APP_USERS, server-side
// sessions in an HttpOnly cookie, login throttling, and role-based permissions.

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import type { Permission, SessionUser } from '../shared/live';
import type { AppConfig, AppUser } from './config';
import { ROLE_PERMISSIONS } from './config';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

function scrypt(password: string, salt: Buffer, N: number, r: number, p: number, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(password, salt, keylen, { N, r, p, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

/** Format: scrypt$N$r$p$saltBase64$hashBase64 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.N, SCRYPT.r, SCRYPT.p, SCRYPT.keylen);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  try {
    const key = await scrypt(password, Buffer.from(saltB64, 'base64'), Number(N), Number(r), Number(p), expected.length);
    return key.length === expected.length && timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

interface Session {
  id: string;
  user: SessionUser;
  expiresAt: number;
}

export const SESSION_COOKIE = 'wad_office_session';

export class Auth {
  private sessions = new Map<string, Session>();
  private attempts = new Map<string, { count: number; until: number }>();
  // A fixed dummy hash keeps response time similar for unknown usernames.
  private dummyHash: Promise<string> = hashPassword(randomBytes(12).toString('hex'));

  constructor(private config: AppConfig) {}

  permissionsFor(role: string): Permission[] {
    return ROLE_PERMISSIONS[role] ?? [];
  }

  /** Returns a session id, null for bad credentials, or 'throttled'. */
  async login(username: string, password: string, clientKey: string): Promise<Session | null | 'throttled'> {
    const now = Date.now();
    // Two limits: 5 failures per address, and 20 per username from any address (so a forged
    // X-Forwarded-For can't give unlimited guesses). Each lasts 5 minutes from the first failure.
    const a = this.attempts.get(clientKey);
    const userKey = `user:${username.toLowerCase()}`;
    const u = this.attempts.get(userKey);
    if ((a && a.count >= 5 && a.until > now) || (u && u.count >= 20 && u.until > now)) return 'throttled';
    const user: AppUser | undefined = this.config.users.find((u) => u.username === username);
    const ok = await verifyPassword(password, user?.passwordHash ?? (await this.dummyHash));
    if (!user || !ok) {
      const bump = (x: { count: number; until: number } | undefined) => (x && x.until > now ? { count: x.count + 1, until: x.until } : { count: 1, until: now + 5 * 60_000 });
      this.attempts.set(clientKey, bump(a));
      this.attempts.set(userKey, bump(u));
      return null;
    }
    this.attempts.delete(clientKey);
    const session: Session = {
      id: randomBytes(32).toString('base64url'),
      user: { username: user.username, role: user.role, permissions: this.permissionsFor(user.role) },
      expiresAt: now + this.config.sessionTtlMs,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string | undefined): Session | null {
    if (!id) return null;
    const s = this.sessions.get(id);
    if (!s) return null;
    if (s.expiresAt <= Date.now()) {
      this.sessions.delete(id);
      return null;
    }
    return s;
  }

  logout(id: string | undefined) {
    if (id) this.sessions.delete(id);
  }

  cookie(session: Session | null): string {
    const parts = [`${SESSION_COOKIE}=${session ? session.id : ''}`, 'Path=/', 'HttpOnly', 'SameSite=Strict'];
    if (this.config.cookieSecure) parts.push('Secure');
    parts.push(session ? `Max-Age=${Math.floor(this.config.sessionTtlMs / 1000)}` : 'Max-Age=0');
    return parts.join('; ');
  }

  sweep() {
    const now = Date.now();
    for (const [k, s] of this.sessions) if (s.expiresAt <= now) this.sessions.delete(k);
    for (const [k, a] of this.attempts) if (a.until <= now) this.attempts.delete(k);
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
