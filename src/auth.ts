import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';
import { one, query } from './db.js';
import { randomToken, sha256 } from './crypto.js';
import { ApiError, forbidden } from './errors.js';

export type Role = 'owner' | 'admin' | 'editor' | 'viewer';

export interface AuthContext {
  /** The account being worked in. Null only for a signed-in user who has no account yet (e.g. removed from their only one). */
  account: any;
  user: any | null;
  /** The user's role in this account; null for API keys (which act with full account access) */
  role: Role | null;
  apiKeyId: string | null;
  /** true for test keys (mk_test_…): emails are processed but never sent */
  testMode: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext;
  }
}

const SESSION_DAYS = 14;

export async function createSession(userId: string, accountId?: string | null) {
  const token = `ms_${randomToken(32)}`;
  await query(
    `INSERT INTO sessions (token_hash, user_id, expires_at, account_id)
     VALUES ($1, $2, now() + make_interval(days => $3), coalesce($4::uuid, (SELECT account_id FROM users WHERE id = $2)))`,
    [sha256(token), userId, SESSION_DAYS, accountId ?? null],
  );
  return token;
}

/** The accounts a user belongs to, owners' first-created first. */
export async function memberships(userId: string) {
  return query<{ id: string; name: string; status: string; type: string; role: Role }>(
    `SELECT a.id, a.name, a.status, a.type, m.role FROM account_members m JOIN accounts a ON a.id = m.account_id
     WHERE m.user_id = $1 ORDER BY a.name, a.created_at`,
    [userId],
  );
}

export async function createApiKey(accountId: string, name: string, mode: 'live' | 'test' = 'live') {
  const key = `mk_${mode}_${randomToken(32)}`;
  const row = await one(
    `INSERT INTO api_keys (account_id, name, prefix, key_hash, mode) VALUES ($1, $2, $3, $4, $5) RETURNING id, name, prefix, mode, created_at`,
    [accountId, name, key.slice(0, 12), sha256(key), mode],
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
    const key = await one(`SELECT id, account_id, mode FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL`, [hash]);
    if (!key) throw new ApiError(401, 'unauthorized', 'מפתח API לא תקין');
    rateLimit(key.id);
    const account = await one('SELECT * FROM accounts WHERE id = $1', [key.account_id]);
    void query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [key.id]);
    req.auth = { account, user: null, role: null, apiKeyId: key.id, testMode: key.mode === 'test' };
    return;
  }
  if (token.startsWith('ms_')) {
    const user = await one(
      `SELECT u.*, s.account_id AS session_account_id FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [hash],
    );
    if (!user) throw new ApiError(401, 'unauthorized', 'פג תוקף ההתחברות. יש להתחבר מחדש');
    rateLimit(user.id);
    // The session's account if the user still belongs to it, else the last used one, else any
    const m = await one<{ account_id: string; role: Role }>(
      `SELECT account_id, role FROM account_members WHERE user_id = $1
       ORDER BY (account_id = $2) DESC NULLS LAST, (account_id = $3) DESC NULLS LAST, created_at LIMIT 1`,
      [user.id, user.session_account_id, user.account_id],
    );
    if (m && m.account_id !== user.session_account_id) await query('UPDATE sessions SET account_id = $2 WHERE token_hash = $1', [hash, m.account_id]);
    const account = m ? await one('SELECT * FROM accounts WHERE id = $1', [m.account_id]) : null;
    delete user.session_account_id;
    req.auth = { account, user, role: m?.role ?? null, apiKeyId: null, testMode: false };
    return;
  }
  throw new ApiError(401, 'unauthorized', 'מפתח API לא תקין');
}

/** Routes that work without an account (a user who has none yet) */
const NO_ACCOUNT_OK = new Set(['/v1/me', '/v1/accounts', '/v1/accounts/switch', '/v1/auth/logout', '/v1/invitations/:token/accept']);
/** User-level routes: an API key acts for an account, not for a person */
const USER_ONLY = new Set(['/v1/accounts', '/v1/accounts/switch', '/v1/members', '/v1/members/:userId', '/v1/members/invitations', '/v1/members/invitations/:id', '/v1/invitations/:token/accept']);
/** Writes an editor may not make: sending setup, keys, integrations, account settings and the team */
const ADMIN_PREFIXES = ['/v1/domains', '/v1/senders', '/v1/api-keys', '/v1/webhooks', '/v1/account', '/v1/members', '/v1/bimi'];
/** Writes anyone signed in may make, whatever their role */
const ANY_ROLE_WRITES = new Set(['/v1/auth/logout', '/v1/accounts', '/v1/accounts/switch', '/v1/invitations/:token/accept']);

const ROLE_NAMES: Record<Role, string> = { owner: 'בעלים', admin: 'מנהל', editor: 'עורך', viewer: 'צופה' };

/** Enforces what each role may do. Runs after authenticate on every /v1 route. */
export async function authorize(req: FastifyRequest) {
  const route = req.routeOptions.url ?? req.url;
  const write = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  if (req.auth.apiKeyId) {
    if (USER_ONLY.has(route)) throw forbidden('הפעולה הזו זמינה רק למשתמש מחובר, לא למפתח API');
    return;
  }
  if (!req.auth.account) {
    if (NO_ACCOUNT_OK.has(route)) return;
    throw new ApiError(409, 'no_account', 'אין לך עדיין חשבון פעיל. פותחים עסק חדש או מקבלים הזמנה לחשבון קיים');
  }
  if (!write || ANY_ROLE_WRITES.has(route) || req.auth.user?.is_superadmin) return;
  const role = req.auth.role!;
  if (role === 'viewer') throw forbidden(`בהרשאת ${ROLE_NAMES.viewer} אפשר רק לצפות`);
  if (role === 'editor' && ADMIN_PREFIXES.some((p) => route === p || route.startsWith(`${p}/`)))
    throw forbidden(`הפעולה הזו דורשת הרשאת ${ROLE_NAMES.admin} או ${ROLE_NAMES.owner}`);
}

export function requireSuperAdmin(req: FastifyRequest) {
  if (!req.auth.user?.is_superadmin) throw forbidden();
}

export function requirePlatform(req: FastifyRequest) {
  if (req.auth.account.type !== 'platform') throw forbidden('הפעולה זמינה רק לחשבונות פלטפורמה');
}
