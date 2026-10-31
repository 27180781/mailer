import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';
import { one, query } from './db.js';
import { randomToken, sha256 } from './crypto.js';
import { ApiError, forbidden } from './errors.js';

export interface AuthContext {
  account: any;
  user: any | null;
  apiKeyId: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext;
  }
}

const SESSION_DAYS = 14;

export async function createSession(userId: string) {
  const token = `ms_${randomToken(32)}`;
  await query(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))`, [sha256(token), userId, SESSION_DAYS]);
  return token;
}

export async function createApiKey(accountId: string, name: string) {
  const key = `mk_live_${randomToken(32)}`;
  const row = await one(
    `INSERT INTO api_keys (account_id, name, prefix, key_hash) VALUES ($1, $2, $3, $4) RETURNING id, name, prefix, created_at`,
    [accountId, name, key.slice(0, 12), sha256(key)],
  );
  return { ...row, key };
}

const windows = new Map<string, { start: number; count: number }>();

function rateLimit(id: string) {
  const now = Date.now();
  const w = windows.get(id);
  if (!w || now - w.start > 60_000) {
    windows.set(id, { start: now, count: 1 });
    return;
  }
  if (++w.count > config.apiRateLimitPerMinute) {
    throw new ApiError(429, 'rate_limited', `יותר מדי בקשות. המגבלה היא ${config.apiRateLimitPerMinute} בקשות בדקה`);
  }
}

/** Accepts an API key (mk_...) or a UI session token (ms_...) as a Bearer token. */
export async function authenticate(req: FastifyRequest, _reply: FastifyReply) {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) throw new ApiError(401, 'unauthorized', 'חסר מפתח API בכותרת Authorization');
  const hash = sha256(token);

  if (token.startsWith('mk_')) {
    const key = await one(`SELECT id, account_id FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL`, [hash]);
    if (!key) throw new ApiError(401, 'unauthorized', 'מפתח API לא תקין');
    rateLimit(key.id);
    const account = await one('SELECT * FROM accounts WHERE id = $1', [key.account_id]);
    void query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [key.id]);
    req.auth = { account, user: null, apiKeyId: key.id };
    return;
  }
  if (token.startsWith('ms_')) {
    const user = await one(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [hash],
    );
    if (!user) throw new ApiError(401, 'unauthorized', 'פג תוקף ההתחברות. יש להתחבר מחדש');
    rateLimit(user.id);
    const account = await one('SELECT * FROM accounts WHERE id = $1', [user.account_id]);
    req.auth = { account, user, apiKeyId: null };
    return;
  }
  throw new ApiError(401, 'unauthorized', 'מפתח API לא תקין');
}

export function requireSuperAdmin(req: FastifyRequest) {
  if (!req.auth.user?.is_superadmin) throw forbidden();
}

export function requirePlatform(req: FastifyRequest) {
  if (req.auth.account.type !== 'platform') throw forbidden('הפעולה זמינה רק לחשבונות פלטפורמה');
}
