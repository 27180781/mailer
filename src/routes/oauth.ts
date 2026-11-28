import type { FastifyInstance, FastifyReply } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { config } from '../config.js';
import { one, query } from '../db.js';
import { randomToken, sha256, verifyPassword } from '../crypto.js';
import { createSession } from '../auth.js';
import { escapeHtml } from '../services/render.js';

/**
 * OAuth 2.1 authorization server for the MCP connector (Claude.ai, Claude Desktop, Claude Code).
 * Dynamic client registration (RFC 7591), authorization code with PKCE S256, refresh tokens.
 * The person signs in with their mailer email and password; the access token acts with their roles.
 */

const ACCESS_TTL_SECONDS = 14 * 86_400; // the session lifetime
const REFRESH_DAYS = 90;

export const mcpResource = () => `${config.publicUrl}/mcp`;

function oauthError(reply: FastifyReply, status: number, error: string, description: string) {
  return reply.code(status).send({ error, error_description: description });
}

const allowedRedirect = (u: string) => {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' || ((url.hostname === 'localhost' || url.hostname === '127.0.0.1') && url.protocol === 'http:');
  } catch { return false; }
};

function loginPage(reply: FastifyReply, p: { client: string; params: Record<string, string>; error?: string; email?: string }) {
  const hidden = Object.entries(p.params).map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`).join('');
  reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').header('x-frame-options', 'DENY');
  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>חיבור ${escapeHtml(p.client)} למערכת הדיוור</title>
<style>body{margin:0;font-family:Heebo,Arial,sans-serif;background:#f5f5f4;color:#1c1917;display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}
.card{background:#fff;border:1px solid #e7e5e4;border-radius:16px;padding:28px;max-width:400px;width:100%;box-shadow:0 10px 30px -12px rgba(0,0,0,.15)}
h1{font-size:21px;margin:0 0 6px}p{color:#57534e;line-height:1.6;margin:0 0 18px}label{display:block;font-weight:600;font-size:14px;margin-bottom:12px}
input[type=email],input[type=password]{display:block;width:100%;box-sizing:border-box;margin-top:6px;padding:12px;border:1px solid #d6d3d1;border-radius:10px;font-size:16px;direction:ltr}
button{width:100%;padding:13px;border:0;border-radius:10px;background:linear-gradient(135deg,#6d5efc,#14b8a6);color:#fff;font-size:16px;font-weight:700;cursor:pointer}
.err{color:#b91c1c;font-size:14px;margin:-6px 0 12px}.small{font-size:12.5px;color:#78716c;margin:14px 0 0}</style></head><body>
<form class="card" method="post" action="/oauth/authorize">
<h1>חיבור ${escapeHtml(p.client)}</h1>
<p>${escapeHtml(p.client)} מבקש גישה לחשבון הדיוור שלך. אחרי ההתחברות הוא יוכל לפעול בשמך, לפי ההרשאות שלך בכל עסק.</p>
${p.error ? `<div class="err">${escapeHtml(p.error)}</div>` : ''}
<label>מייל<input name="email" type="email" required autocomplete="email" value="${escapeHtml(p.email ?? '')}"></label>
<label>סיסמה<input name="password" type="password" required autocomplete="current-password"></label>
${hidden}<button type="submit">התחברות ואישור</button>
<p class="small">אפשר לבטל את הגישה בכל רגע: יוצאים מהחיבור ב-Claude, או משנים סיסמה.</p></form></body></html>`;
}

export async function oauthRoutes(app: FastifyInstance) {
  // Where Claude learns how to authenticate to /mcp
  app.get('/.well-known/oauth-protected-resource', async () => ({
    resource: mcpResource(),
    authorization_servers: [config.publicUrl],
    bearer_methods_supported: ['header'],
    resource_name: 'מערכת הדיוור',
  }));
  app.get('/.well-known/oauth-protected-resource/mcp', async () => ({
    resource: mcpResource(),
    authorization_servers: [config.publicUrl],
    bearer_methods_supported: ['header'],
  }));
  app.get('/.well-known/oauth-authorization-server', async () => ({
    issuer: config.publicUrl,
    authorization_endpoint: `${config.publicUrl}/oauth/authorize`,
    token_endpoint: `${config.publicUrl}/oauth/token`,
    registration_endpoint: `${config.publicUrl}/oauth/register`,
    revocation_endpoint: `${config.publicUrl}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['mailer'],
  }));

  app.post('/oauth/register', async (req, reply) => {
    const b = z
      .object({ client_name: z.string().max(200).optional(), redirect_uris: z.array(z.string().max(2000)).min(1).max(10) })
      .passthrough()
      .safeParse(req.body ?? {});
    if (!b.success) return oauthError(reply, 400, 'invalid_client_metadata', 'redirect_uris is required');
    if (!b.data.redirect_uris.every(allowedRedirect)) return oauthError(reply, 400, 'invalid_redirect_uri', 'redirect URIs must be https (or http on localhost)');
    const clientId = `mcp_${randomToken(18)}`;
    await query('INSERT INTO oauth_clients (client_id, client_name, redirect_uris) VALUES ($1, $2, $3)', [clientId, b.data.client_name ?? 'Claude', b.data.redirect_uris]);
    reply.code(201);
    return {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: b.data.client_name ?? 'Claude',
      redirect_uris: b.data.redirect_uris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  });

  const authorizeParams = z.object({
    response_type: z.literal('code'),
    client_id: z.string().min(1).max(200),
    redirect_uri: z.string().min(1).max(2000),
    code_challenge: z.string().min(43).max(128),
    code_challenge_method: z.literal('S256'),
    state: z.string().max(2000).optional(),
    scope: z.string().max(500).optional(),
    resource: z.string().max(2000).optional(),
  });
  async function checkClient(p: z.infer<typeof authorizeParams>) {
    const client = await one('SELECT * FROM oauth_clients WHERE client_id = $1', [p.client_id]);
    if (!client || !client.redirect_uris.includes(p.redirect_uri)) return null;
    return client;
  }
  const paramsOf = (p: any) => Object.fromEntries(Object.entries(p).filter(([k, v]) => v !== undefined && authorizeParams.shape[k as keyof typeof authorizeParams.shape]).map(([k, v]) => [k, String(v)]));

  app.get('/oauth/authorize', async (req, reply) => {
    const p = authorizeParams.safeParse(req.query);
    if (!p.success) return reply.code(400).type('text/html; charset=utf-8').send('<p dir="rtl">בקשת חיבור לא תקינה (חסר PKCE או פרמטר).</p>');
    const client = await checkClient(p.data);
    if (!client) return reply.code(400).type('text/html; charset=utf-8').send('<p dir="rtl">אפליקציה לא מוכרת או כתובת חזרה לא תואמת.</p>');
    return loginPage(reply, { client: client.client_name || 'Claude', params: paramsOf(p.data) });
  });

  app.post('/oauth/authorize', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, string>;
    const p = authorizeParams.safeParse(body);
    if (!p.success) return reply.code(400).type('text/html; charset=utf-8').send('<p dir="rtl">בקשת חיבור לא תקינה.</p>');
    const client = await checkClient(p.data);
    if (!client) return reply.code(400).type('text/html; charset=utf-8').send('<p dir="rtl">אפליקציה לא מוכרת או כתובת חזרה לא תואמת.</p>');
    const email = String(body.email ?? '').trim().toLowerCase();
    const user = await one('SELECT * FROM users WHERE email = $1', [email]);
    if (!user || !(await verifyPassword(String(body.password ?? ''), user.password_hash))) {
      return loginPage(reply.code(401), { client: client.client_name || 'Claude', params: paramsOf(p.data), error: 'מייל או סיסמה שגויים', email });
    }
    const code = randomToken(32);
    await query(
      `INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, expires_at) VALUES ($1, $2, $3, $4, $5, now() + interval '10 minutes')`,
      [sha256(code), client.client_id, user.id, p.data.redirect_uri, p.data.code_challenge],
    );
    const to = new URL(p.data.redirect_uri);
    to.searchParams.set('code', code);
    if (p.data.state) to.searchParams.set('state', p.data.state);
    return reply.redirect(to.toString(), 302);
  });

  async function issueTokens(clientId: string, userId: string) {
    const access = await createSession(userId);
    const refresh = `mr_${randomToken(32)}`;
    await query(
      `INSERT INTO oauth_refresh_tokens (token_hash, client_id, user_id, expires_at) VALUES ($1, $2, $3, now() + make_interval(days => $4))`,
      [sha256(refresh), clientId, userId, REFRESH_DAYS],
    );
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_SECONDS, refresh_token: refresh, scope: 'mailer' };
  }

  app.post('/oauth/token', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const b = (req.body ?? {}) as Record<string, string>;
    if (b.grant_type === 'authorization_code') {
      if (!b.code || !b.code_verifier || !b.client_id || !b.redirect_uri) return oauthError(reply, 400, 'invalid_request', 'missing parameters');
      const row = await one(
        `UPDATE oauth_codes SET used_at = now() WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING *`,
        [sha256(b.code)],
      );
      if (!row || row.client_id !== b.client_id || row.redirect_uri !== b.redirect_uri) return oauthError(reply, 400, 'invalid_grant', 'code is invalid or expired');
      const challenge = createHash('sha256').update(b.code_verifier).digest('base64url');
      if (challenge !== row.code_challenge) return oauthError(reply, 400, 'invalid_grant', 'PKCE verification failed');
      return issueTokens(row.client_id, row.user_id);
    }
    if (b.grant_type === 'refresh_token') {
      if (!b.refresh_token) return oauthError(reply, 400, 'invalid_request', 'missing refresh_token');
      // Rotation: the old refresh token is used up
      const row = await one(
        `UPDATE oauth_refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now() RETURNING *`,
        [sha256(b.refresh_token)],
      );
      if (!row || (b.client_id && row.client_id !== b.client_id)) return oauthError(reply, 400, 'invalid_grant', 'refresh token is invalid or expired');
      return issueTokens(row.client_id, row.user_id);
    }
    return oauthError(reply, 400, 'unsupported_grant_type', 'use authorization_code or refresh_token');
  });

  app.post('/oauth/revoke', async (req) => {
    const t = String(((req.body ?? {}) as any).token ?? '');
    if (t.startsWith('mr_')) await query('UPDATE oauth_refresh_tokens SET revoked_at = now() WHERE token_hash = $1', [sha256(t)]);
    if (t.startsWith('ms_')) await query('DELETE FROM sessions WHERE token_hash = $1', [sha256(t)]);
    return {};
  });
}
