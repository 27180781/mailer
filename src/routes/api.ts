import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { one, query, tx } from '../db.js';
import { hashPassword, verifyPassword, sha256, randomToken } from '../crypto.js';
import { ApiError, notFound } from '../errors.js';
import { authenticate, authorize, createApiKey, createSession, memberships, requirePlatform, requireSuperAdmin, type Role } from '../auth.js';
import { sendSystemEmail } from '../services/systemEmail.js';
import { inforuTestSend } from '../services/inforuCampaigns.js';
import { inforuGroups, inforuVerify } from '../providers/inforu.js';
import { inforuCredentials } from '../services/inforuCampaigns.js';
import { encryptSecret } from '../crypto.js';
import { escapeHtml } from '../services/render.js';
import { addDomain, checkDomain, deleteDomain, publicDomain, zoneFile } from '../services/domains.js';
import { bimiRecordValue, bimiStatus, validateBimiSvg, validateCertificate } from '../services/bimi.js';
import { enqueueEmail, resolveFrom, sentToday } from '../services/send.js';
import { campaignStats } from '../services/campaigns.js';
import { contactPayload, emitEvent, newWebhookSecret, WEBHOOK_EVENTS } from '../services/webhooks.js';
import { suppress, unsubscribeContact } from '../services/suppression.js';
import { runAutoTrust, trustInfo } from '../services/trust.js';
import { backupConfig, backupConfigured, backupStatus, listBackups, runBackup } from '../services/backup.js';
import { applyRecords } from '../services/cloudflare.js';
import { applyParams, applyUrl, discover, publicKeyPublished, publicKeyRecords, templates, templateSupported, DC_PROVIDER_ID } from '../services/domainConnect.js';

const email = z.string().trim().toLowerCase().email('כתובת מייל לא תקינה');
/** Accepts "Name <a@b.co>" (as Resend and most libraries do) as well as a bare address. */
const NAMED = /^\s*"?([^"<]*?)"?\s*<([^<>\s]+@[^<>\s]+)>\s*$/;
const namedAddress = z.string().transform((v, ctx) => {
  const m = v.match(NAMED);
  const parsed = m ? { name: m[1].trim() || null, email: m[2] } : { name: null as string | null, email: v };
  const ok = email.safeParse(parsed.email);
  if (!ok.success) { ctx.addIssue({ code: 'custom', message: 'כתובת מייל לא תקינה' }); return z.NEVER; }
  return { name: parsed.name, email: ok.data };
});
const looseEmail = namedAddress.transform((a) => a.email);
const uuid = z.string().uuid('מזהה לא תקין');
/** Automation tools (Make, Zapier) send "" for fields left empty: treat it as not given */
const blank = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const page = z.object({ limit: z.coerce.number().int().min(1).max(500).default(50), offset: z.coerce.number().int().min(0).default(0) });

const attachment = z.object({
  filename: z.string().min(1).max(200),
  content: z.string().min(1),
  content_type: z.string().optional(),
});

const MAX_ATTACHMENTS_BYTES = 10 * 1024 * 1024;

const sendSchema = z
  .object({
    sender_id: uuid.nullish(),
    from: z.union([namedAddress, z.object({ email, name: z.string().max(120).nullish() })]),
    fallback: z.enum(['platform', 'reject']).default('reject'),
    reply_to: z.preprocess(blank, z.union([looseEmail, z.array(looseEmail).max(1).transform((a) => a[0])]).nullish()),
    to: z.union([looseEmail.transform((e) => [e]), z.array(looseEmail).min(1).max(50)]),
    cc: z.union([looseEmail.transform((e) => [e]), z.array(looseEmail).max(49)]).default([]),
    bcc: z.union([looseEmail.transform((e) => [e]), z.array(looseEmail).max(49)]).default([]),
    subject: z.string().min(1).max(998),
    html: z.string().max(2_000_000).nullish(),
    text: z.string().max(1_000_000).nullish(),
    type: z.enum(['transactional', 'marketing']).default('transactional'),
    ad_label: z.boolean().optional(),
    attachments: z.array(attachment).max(10).default([]),
    headers: z
      .record(z.string().regex(/^(X-[A-Za-z0-9-]+|Message-ID|In-Reply-To|References)$/i, 'מותרות כותרות X-…, ו-Message-ID, In-Reply-To, References'), z.string().max(2000))
      .default({}),
    metadata: z.record(z.unknown()).default({}),
    scheduled_at: z.string().datetime().nullish(),
  })
  .refine((v) => v.html || v.text, { message: 'צריך html או text' })
  // Marketing mail has a personal unsubscribe link: one message per recipient, so no shared CC/BCC
  .refine((v) => v.type !== 'marketing' || (v.cc.length === 0 && v.bcc.length === 0), { message: 'במייל שיווקי (type=marketing) אי אפשר להשתמש ב-cc או ב-bcc. כל נמען מקבל מייל משלו עם קישור הסרה אישי' })
  .refine((v) => v.attachments.reduce((n, a) => n + (a.content.length * 3) / 4, 0) <= MAX_ATTACHMENTS_BYTES, {
    message: 'גודל הקבצים המצורפים חורג מ-10MB',
  });

function publicAccount(a: any) {
  const { paused_reason, inforu_token_enc, ...rest } = a;
  return { ...rest, paused_reason, inforu_connected: !!(a.inforu_username && inforu_token_enc) };
}

/** A contact by its id or by its email address (handy for Zapier, Make and CRMs that only know the email). */
async function findContact(ref: string, accountId: string) {
  const byId = uuid.safeParse(ref).success;
  const row = await one(`SELECT * FROM contacts WHERE account_id = $1 AND ${byId ? 'id = $2::uuid' : 'email = lower(trim($2))'}`, [accountId, ref]);
  if (!row) throw notFound('איש הקשר');
  return row;
}

async function owned(table: string, id: string, accountId: string, what: string) {
  const row = await one(`SELECT * FROM ${table} WHERE id = $1 AND account_id = $2`, [id, accountId]);
  if (!row) throw notFound(what);
  return row;
}

/** The operator's Cloudflare token is offered only to the operator's own accounts. */
async function canUseOperatorCloudflare(req: any) {
  if (!config.cloudflareToken) return false;
  if (req.auth.user?.is_superadmin || req.auth.account.can_use_reserved_domains) return true;
  const admin = await one('SELECT 1 FROM account_members m JOIN users u ON u.id = m.user_id WHERE m.account_id = $1 AND u.is_superadmin', [req.auth.account.id]);
  return !!admin;
}

export async function apiRoutes(app: FastifyInstance) {
  // ---------- Auth (no token) ----------
  app.post('/v1/auth/signup', async (req, reply) => {
    const b = z
      .object({
        email,
        password: z.string().min(10, 'הסיסמה צריכה להיות באורך 10 תווים לפחות'),
        name: z.string().min(1).max(120),
        account_name: z.string().min(1).max(120),
        company_address: z.string().max(300).optional(),
      })
      .parse(req.body);
    if (await one('SELECT 1 FROM users WHERE email = $1', [b.email])) throw new ApiError(409, 'email_taken', 'כבר קיים משתמש עם המייל הזה');
    const superadmin = config.superAdmins.includes(b.email);
    const result = await tx(async (c) => {
      const account = (
        await c.query(
          `INSERT INTO accounts (name, company_name, company_address, contact_email, daily_limit, status) VALUES ($1, $1, $2, $3, $4, $5) RETURNING *`,
          [b.account_name, b.company_address ?? null, b.email, config.newAccountDailyLimit, superadmin ? 'active' : 'pending'],
        )
      ).rows[0];
      const user = (
        await c.query(`INSERT INTO users (account_id, email, name, password_hash, is_superadmin) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [
          account.id,
          b.email,
          b.name,
          await hashPassword(b.password),
          superadmin,
        ])
      ).rows[0];
      await c.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'owner')`, [account.id, user.id]);
      return { account, user };
    });
    reply.code(201);
    return { token: await createSession(result.user.id, result.account.id), account: publicAccount(result.account) };
  });

  app.post('/v1/auth/login', async (req) => {
    const b = z.object({ email, password: z.string() }).parse(req.body);
    const user = await one('SELECT * FROM users WHERE email = $1', [b.email]);
    if (!user || !(await verifyPassword(b.password, user.password_hash))) throw new ApiError(401, 'invalid_login', 'מייל או סיסמה שגויים');
    return { token: await createSession(user.id) };
  });

  // ---------- Team invitations (the link in the email; works signed in or not) ----------
  const ROLE_LABEL: Record<string, string> = { owner: 'בעלים', admin: 'מנהל', editor: 'עורך', viewer: 'צופה' };
  async function openInvitation(token: string) {
    const inv = await one(
      `SELECT i.*, a.name AS account_name, a.status AS account_status, u.name AS invited_by_name
       FROM account_invitations i JOIN accounts a ON a.id = i.account_id LEFT JOIN users u ON u.id = i.invited_by
       WHERE i.token_hash = $1`,
      [sha256(token)],
    );
    if (!inv || inv.account_status === 'suspended') throw new ApiError(404, 'invitation_not_found', 'ההזמנה לא נמצאה');
    if (inv.accepted_at) throw new ApiError(410, 'invitation_used', 'כבר השתמשו בהזמנה הזו');
    if (new Date(inv.expires_at) < new Date()) throw new ApiError(410, 'invitation_expired', 'פג תוקף ההזמנה. בקשו הזמנה חדשה');
    return inv;
  }
  app.get('/v1/invitations/:token', async (req) => {
    const inv = await openInvitation(String((req.params as any).token));
    return {
      account_name: inv.account_name,
      email: inv.email,
      role: inv.role,
      role_label: ROLE_LABEL[inv.role],
      invited_by: inv.invited_by_name,
      expires_at: inv.expires_at,
      user_exists: !!(await one('SELECT 1 FROM users WHERE email = $1', [inv.email])),
    };
  });
  /**
   * Accepts an invitation. Signed in (Bearer ms_…): joins that user. Not signed in: creates the user for the invited
   * email (name + password) and signs them in. An existing user who is not signed in must sign in first.
   */
  app.post('/v1/invitations/:token/accept', async (req) => {
    const inv = await openInvitation(String((req.params as any).token));
    let userId: string;
    let token: string | null = null;
    if (req.headers.authorization?.startsWith('Bearer ms_')) {
      await authenticate(req, undefined as any);
      userId = req.auth.user.id;
    } else {
      const b = z
        .object({ name: z.string().min(1, 'צריך שם').max(120), password: z.string().min(10, 'הסיסמה צריכה להיות באורך 10 תווים לפחות') })
        .parse(req.body ?? {});
      if (await one('SELECT 1 FROM users WHERE email = $1', [inv.email])) throw new ApiError(409, 'login_required', 'כבר יש משתמש עם המייל הזה. מתחברים ואז מקבלים את ההזמנה');
      const u = await one(
        `INSERT INTO users (account_id, email, name, password_hash, is_superadmin) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [inv.account_id, inv.email, b.name, await hashPassword(b.password), config.superAdmins.includes(inv.email)],
      );
      userId = u.id;
    }
    await tx(async (c) => {
      const claimed = await c.query(`UPDATE account_invitations SET accepted_at = now(), accepted_by = $2 WHERE id = $1 AND accepted_at IS NULL RETURNING id`, [inv.id, userId]);
      if (!claimed.rowCount) throw new ApiError(410, 'invitation_used', 'כבר השתמשו בהזמנה הזו');
      // Joining never lowers an existing role
      await c.query(
        `INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)
         ON CONFLICT (account_id, user_id) DO UPDATE SET role = CASE
           WHEN array_position(ARRAY['viewer','editor','admin','owner'], account_members.role) >= array_position(ARRAY['viewer','editor','admin','owner'], EXCLUDED.role)
           THEN account_members.role ELSE EXCLUDED.role END`,
        [inv.account_id, userId, inv.role],
      );
      await c.query('UPDATE users SET account_id = $2 WHERE id = $1', [userId, inv.account_id]);
    });
    if (req.auth?.user) await query('UPDATE sessions SET account_id = $2 WHERE token_hash = $1', [sha256(req.headers.authorization!.slice(7).trim()), inv.account_id]);
    else token = await createSession(userId, inv.account_id);
    return { ok: true, account_id: inv.account_id, account_name: inv.account_name, role: inv.role, ...(token ? { token } : {}) };
  });

  // ---------- Everything below needs a token ----------
  app.register(async (r) => {
    r.addHook('preHandler', authenticate);
    r.addHook('preHandler', authorize);

    r.post('/v1/auth/logout', async (req) => {
      const token = req.headers.authorization!.slice(7).trim();
      await query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
      return { ok: true };
    });

    r.get('/v1/me', async (req) => {
      const a = req.auth.account;
      const user = req.auth.user && { id: req.auth.user.id, email: req.auth.user.email, name: req.auth.user.name, is_superadmin: req.auth.user.is_superadmin };
      const accounts = req.auth.user ? await memberships(req.auth.user.id) : undefined;
      if (!a) return { account: null, user, role: null, accounts, can_create_account: await canCreateAccount(req.auth.user) };
      return {
        account: publicAccount(a),
        user,
        role: req.auth.role,
        accounts,
        can_create_account: req.auth.user ? await canCreateAccount(req.auth.user) : undefined,
        usage: { today: await sentToday(a.id), daily_limit: a.daily_limit },
        trust: await trustInfo(a),
        cloudflare_operator: await canUseOperatorCloudflare(req),
        test_mode: req.auth.testMode,
      };
    });

    // ---------- Businesses (accounts) of the signed-in user ----------
    async function canCreateAccount(user: any) {
      if (user.is_superadmin) return true;
      const owned = await one<{ n: number }>(`SELECT count(*)::int AS n FROM account_members WHERE user_id = $1 AND role = 'owner'`, [user.id]);
      return owned!.n < (user.max_owned_accounts ?? config.maxAccountsPerUser);
    }
    r.get('/v1/accounts', async (req) => memberships(req.auth.user.id));
    /** Opens another business. It starts like any new account: pending, with the new-account daily limit. */
    r.post('/v1/accounts', async (req, reply) => {
      const user = req.auth.user;
      const b = z.object({ name: z.string().trim().min(1, 'צריך שם לעסק').max(120), company_address: z.string().max(300).optional() }).parse(req.body);
      if (!(await canCreateAccount(user)))
        throw new ApiError(403, 'account_limit', `אפשר לפתוח עד ${user.max_owned_accounts ?? config.maxAccountsPerUser} עסקים. לעסקים נוספים פונים למנהל המערכת`);
      const account = await tx(async (c) => {
        const a = (
          await c.query(
            `INSERT INTO accounts (name, company_name, company_address, contact_email, daily_limit, status) VALUES ($1, $1, $2, $3, $4, $5) RETURNING *`,
            [b.name, b.company_address ?? null, user.email, config.newAccountDailyLimit, user.is_superadmin ? 'active' : 'pending'],
          )
        ).rows[0];
        await c.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'owner')`, [a.id, user.id]);
        return a;
      });
      await switchTo(req, account.id);
      reply.code(201);
      return publicAccount(account);
    });
    async function switchTo(req: any, accountId: string) {
      const token = req.headers.authorization!.slice(7).trim();
      await query('UPDATE sessions SET account_id = $2 WHERE token_hash = $1', [sha256(token), accountId]);
      await query('UPDATE users SET account_id = $2 WHERE id = $1', [req.auth.user.id, accountId]);
    }
    r.post('/v1/accounts/switch', async (req) => {
      const { account_id } = z.object({ account_id: uuid }).parse(req.body);
      const m = await one('SELECT role FROM account_members WHERE account_id = $1 AND user_id = $2', [account_id, req.auth.user.id]);
      if (!m) throw notFound('החשבון');
      await switchTo(req, account_id);
      return { ok: true, account_id, role: m.role };
    });

    // ---------- Team ----------
    const RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };
    r.get('/v1/members', async (req) => {
      const accountId = req.auth.account.id;
      const members = await query(
        `SELECT u.id AS user_id, u.email, u.name, m.role, m.created_at FROM account_members m JOIN users u ON u.id = m.user_id
         WHERE m.account_id = $1 ORDER BY array_position(ARRAY['owner','admin','editor','viewer'], m.role), u.name`,
        [accountId],
      );
      const invitations = await query(
        `SELECT i.id, i.email, i.role, i.expires_at, i.created_at, u.name AS invited_by FROM account_invitations i LEFT JOIN users u ON u.id = i.invited_by
         WHERE i.account_id = $1 AND i.accepted_at IS NULL AND i.expires_at > now() ORDER BY i.created_at DESC`,
        [accountId],
      );
      return { members, invitations, my_role: req.auth.role };
    });
    r.post('/v1/members/invitations', async (req, reply) => {
      const accountId = req.auth.account.id;
      const b = z.object({ email, role: z.enum(['admin', 'editor', 'viewer']).default('editor') }).parse(req.body);
      const existing = await one(`SELECT 1 FROM account_members m JOIN users u ON u.id = m.user_id WHERE m.account_id = $1 AND u.email = $2`, [accountId, b.email]);
      if (existing) throw new ApiError(409, 'already_member', 'המשתמש הזה כבר בצוות');
      const token = `inv_${randomToken(24)}`;
      // A new invitation to the same email replaces the previous one
      await query(`DELETE FROM account_invitations WHERE account_id = $1 AND email = $2 AND accepted_at IS NULL`, [accountId, b.email]);
      const inv = await one(
        `INSERT INTO account_invitations (account_id, email, role, token_hash, invited_by, expires_at) VALUES ($1, $2, $3, $4, $5, now() + interval '7 days')
         RETURNING id, email, role, expires_at, created_at`,
        [accountId, b.email, b.role, sha256(token), req.auth.user.id],
      );
      const link = `${config.publicUrl}/app/#/invite/${token}`;
      const who = escapeHtml(req.auth.user.name || req.auth.user.email);
      const biz = escapeHtml(req.auth.account.name);
      const emailed = await sendSystemEmail(
        b.email,
        `${req.auth.user.name || req.auth.user.email} הזמין/ה אותך לצוות של ${req.auth.account.name}`,
        `<div dir="rtl" style="font-family:Arial,sans-serif;font-size:16px;line-height:1.6">
          <p>שלום,</p>
          <p>${who} הזמין/ה אותך להצטרף לחשבון הדיוור של <b>${biz}</b>, בהרשאת ${ROLE_LABEL[b.role]}.</p>
          <p><a href="${link}" style="display:inline-block;background:#1c1917;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none">הצטרפות לצוות</a></p>
          <p style="color:#78716c;font-size:13px">ההזמנה בתוקף לשבעה ימים. אם לא ציפית להזמנה הזו, אפשר להתעלם מהמייל.</p></div>`,
      ).catch((err) => {
        req.log.error(err, 'invitation email failed');
        return false;
      });
      reply.code(201);
      return { ...inv, link, emailed };
    });
    r.delete('/v1/members/invitations/:id', async (req) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      await query('DELETE FROM account_invitations WHERE id = $1 AND account_id = $2 AND accepted_at IS NULL', [id, req.auth.account.id]);
      return { ok: true };
    });
    async function memberOrThrow(accountId: string, userId: string) {
      const m = await one<{ role: Role }>('SELECT role FROM account_members WHERE account_id = $1 AND user_id = $2', [accountId, userId]);
      if (!m) throw notFound('חבר הצוות');
      return m;
    }
    async function ownerCount(accountId: string) {
      return (await one<{ n: number }>(`SELECT count(*)::int AS n FROM account_members WHERE account_id = $1 AND role = 'owner'`, [accountId]))!.n;
    }
    /** Admins manage editors and viewers; only owners touch owners or make someone an owner. */
    function canManage(actor: Role | null, isSuper: boolean, target: Role, next?: Role) {
      if (isSuper || actor === 'owner') return true;
      return actor === 'admin' && RANK[target] < RANK.owner && (!next || RANK[next] < RANK.owner);
    }
    r.patch('/v1/members/:userId', async (req) => {
      const { userId } = z.object({ userId: uuid }).parse(req.params);
      const { role } = z.object({ role: z.enum(['owner', 'admin', 'editor', 'viewer']) }).parse(req.body);
      const accountId = req.auth.account.id;
      const m = await memberOrThrow(accountId, userId);
      if (!canManage(req.auth.role, req.auth.user.is_superadmin, m.role, role)) throw new ApiError(403, 'forbidden', 'רק בעלים יכולים לשנות הרשאות של בעלים או למנות בעלים');
      if (m.role === 'owner' && role !== 'owner' && (await ownerCount(accountId)) <= 1) throw new ApiError(409, 'last_owner', 'בחשבון חייב להישאר לפחות בעלים אחד');
      await query('UPDATE account_members SET role = $3 WHERE account_id = $1 AND user_id = $2', [accountId, userId, role]);
      return { ok: true, user_id: userId, role };
    });
    r.delete('/v1/members/:userId', async (req) => {
      const { userId } = z.object({ userId: uuid }).parse(req.params);
      const accountId = req.auth.account.id;
      const m = await memberOrThrow(accountId, userId);
      const self = userId === req.auth.user.id;
      if (!self && !canManage(req.auth.role, req.auth.user.is_superadmin, m.role)) throw new ApiError(403, 'forbidden', 'רק בעלים יכולים להסיר בעלים');
      if (m.role === 'owner' && (await ownerCount(accountId)) <= 1) throw new ApiError(409, 'last_owner', 'בחשבון חייב להישאר לפחות בעלים אחד. ממנים בעלים נוסף ואז אפשר לעזוב');
      await query('DELETE FROM account_members WHERE account_id = $1 AND user_id = $2', [accountId, userId]);
      // Their sessions in this account move to another account (or none) on the next request
      return { ok: true };
    });

    /** Daily counts for the dashboard chart, plus totals for the period (Israel time). */
    r.get('/v1/stats', async (req) => {
      const { days } = z.object({ days: z.coerce.number().int().min(1).max(90).default(14) }).parse(req.query);
      const daily = await query(
        `WITH d AS (
           SELECT generate_series((now() AT TIME ZONE 'Asia/Jerusalem')::date - ($2::int - 1), (now() AT TIME ZONE 'Asia/Jerusalem')::date, interval '1 day')::date AS day
         )
         SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
           count(m.id) FILTER (WHERE m.status IN ('sent','delivered','bounced','complained'))::int AS sent,
           count(m.id) FILTER (WHERE m.status = 'delivered')::int AS delivered,
           count(m.id) FILTER (WHERE m.status IN ('bounced','complained','failed'))::int AS problems,
           count(m.opened_at)::int AS opened,
           count(m.clicked_at)::int AS clicked
         FROM d LEFT JOIN messages m ON m.account_id = $1 AND (m.created_at AT TIME ZONE 'Asia/Jerusalem')::date = d.day
         GROUP BY d.day ORDER BY d.day`,
        [req.auth.account.id, days],
      );
      const totals = daily.reduce(
        (t: any, r: any) => ({ sent: t.sent + r.sent, delivered: t.delivered + r.delivered, problems: t.problems + r.problems, opened: t.opened + r.opened, clicked: t.clicked + r.clicked }),
        { sent: 0, delivered: 0, problems: 0, opened: 0, clicked: 0 },
      );
      const [counts] = await query(
        `SELECT (SELECT count(*)::int FROM contacts WHERE account_id = $1 AND status = 'active') AS contacts,
                (SELECT count(*)::int FROM lists WHERE account_id = $1) AS lists,
                (SELECT count(*)::int FROM domains WHERE account_id = $1 AND status = 'verified') AS verified_domains,
                (SELECT count(*)::int FROM domains WHERE account_id = $1) AS domains`,
        [req.auth.account.id],
      );
      // Not yet confirmed by the receiving server (in flight or deferred, e.g. by Gmail rate limits), and unsubscribes
      const [extra] = await query(
        `SELECT (SELECT count(*)::int FROM messages WHERE account_id = $1 AND status = 'sent' AND NOT test
                   AND (created_at AT TIME ZONE 'Asia/Jerusalem')::date > (now() AT TIME ZONE 'Asia/Jerusalem')::date - $2::int) AS pending,
                (SELECT count(*)::int FROM events e JOIN messages m ON m.id = e.message_id WHERE e.account_id = $1 AND e.type = 'unsubscribed' AND NOT m.test
                   AND (e.created_at AT TIME ZONE 'Asia/Jerusalem')::date > (now() AT TIME ZONE 'Asia/Jerusalem')::date - $2::int) AS unsubscribed`,
        [req.auth.account.id, days],
      );
      Object.assign(totals, extra);
      return { days, daily, totals, counts };
    });

    // ---------- InforUMobile (optional channel for campaigns) ----------
    r.get('/v1/account/inforu', async (req) => ({
      connected: !!(req.auth.account.inforu_username && req.auth.account.inforu_token_enc),
      username: req.auth.account.inforu_username ?? null,
    }));
    /** Saves the InforU API login after checking it with InforU. The token is stored encrypted and never returned. */
    r.put('/v1/account/inforu', async (req) => {
      const b = z.object({ username: z.string().trim().min(1, 'צריך שם משתמש').max(200), token: z.string().trim().min(8, 'צריך טוקן API').max(500) }).parse(req.body);
      try {
        await inforuVerify(b);
      } catch (err: any) {
        throw new ApiError(400, 'inforu_auth_failed', String(err?.message ?? err));
      }
      await query('UPDATE accounts SET inforu_username = $2, inforu_token_enc = $3 WHERE id = $1', [req.auth.account.id, b.username, encryptSecret(b.token)]);
      return { connected: true, username: b.username };
    });
    r.get('/v1/account/inforu/groups', async (req) => {
      const creds = inforuCredentials(req.auth.account);
      if (!creds) throw new ApiError(400, 'inforu_not_connected', 'InforU לא מחובר לחשבון');
      try { return await inforuGroups(creds); } catch (err: any) { throw new ApiError(502, 'inforu_error', String(err?.message ?? err)); }
    });
    r.delete('/v1/account/inforu', async (req) => {
      await query('UPDATE accounts SET inforu_username = NULL, inforu_token_enc = NULL WHERE id = $1', [req.auth.account.id]);
      return { connected: false };
    });

    r.patch('/v1/account', async (req) => {
      const b = z
        .object({
          name: z.string().min(1).max(120).optional(),
          company_name: z.string().max(120).nullish(),
          company_address: z.string().max(300).nullish(),
          contact_email: email.nullish(),
          fallback_from_email: email.nullish(),
          fallback_name_template: z.string().max(120).optional(),
          track_transactional: z.boolean().optional(),
          ad_label_default: z.boolean().optional(),
        })
        .parse(req.body);
      const fields = Object.entries(b).filter(([, v]) => v !== undefined);
      if (!fields.length) return publicAccount(req.auth.account);
      const sets = fields.map(([k], i) => `${k} = $${i + 2}`).join(', ');
      return publicAccount(await one(`UPDATE accounts SET ${sets} WHERE id = $1 RETURNING *`, [req.auth.account.id, ...fields.map(([, v]) => v)]));
    });

    // ---------- API keys ----------
    r.get('/v1/api-keys', async (req) =>
      query(`SELECT id, name, prefix, mode, last_used_at, created_at FROM api_keys WHERE account_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC`, [req.auth.account.id]),
    );
    r.post('/v1/api-keys', async (req, reply) => {
      const b = z.object({ name: z.string().min(1).max(80), mode: z.enum(['live', 'test']).default('live') }).parse(req.body);
      reply.code(201);
      return createApiKey(req.auth.account.id, b.name, b.mode);
    });
    r.delete('/v1/api-keys/:id', async (req) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      await query('UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND account_id = $2', [id, req.auth.account.id]);
      return { ok: true };
    });

    // ---------- Senders (platform accounts: one per end customer, e.g. a business in Retzef) ----------
    r.get('/v1/senders', async (req) => {
      requirePlatform(req);
      const q = page.extend({ external_id: z.string().optional() }).parse(req.query);
      return query(
        `SELECT s.*, (SELECT json_agg(json_build_object('id', d.id, 'name', d.name, 'status', d.status)) FROM domains d WHERE d.sender_id = s.id) AS domains
         FROM senders s WHERE account_id = $1 AND ($2::text IS NULL OR external_id = $2) ORDER BY created_at DESC LIMIT $3 OFFSET $4`,
        [req.auth.account.id, q.external_id ?? null, q.limit, q.offset],
      );
    });
    r.post('/v1/senders', async (req, reply) => {
      requirePlatform(req);
      const b = z.object({ name: z.string().min(1).max(120), external_id: z.string().max(120).nullish(), default_reply_to: email.nullish() }).parse(req.body);
      const row = await one(
        `INSERT INTO senders (account_id, name, external_id, default_reply_to) VALUES ($1, $2, $3, $4)
         ON CONFLICT (account_id, external_id) DO NOTHING RETURNING *`,
        [req.auth.account.id, b.name, b.external_id ?? null, b.default_reply_to ?? null],
      );
      if (!row) throw new ApiError(409, 'sender_exists', 'כבר קיים שולח עם המזהה החיצוני הזה');
      reply.code(201);
      return row;
    });
    r.get('/v1/senders/:id', async (req) => {
      requirePlatform(req);
      const { id } = z.object({ id: uuid }).parse(req.params);
      const s = await owned('senders', id, req.auth.account.id, 'השולח');
      const domains = await query('SELECT * FROM domains WHERE sender_id = $1', [id]);
      return { ...s, domains: domains.map(publicDomain) };
    });
    r.patch('/v1/senders/:id', async (req) => {
      requirePlatform(req);
      const { id } = z.object({ id: uuid }).parse(req.params);
      await owned('senders', id, req.auth.account.id, 'השולח');
      const b = z.object({ name: z.string().min(1).max(120).optional(), default_reply_to: email.nullish(), status: z.enum(['active', 'suspended']).optional() }).parse(req.body);
      return one(
        `UPDATE senders SET name = coalesce($2, name), default_reply_to = CASE WHEN $3::boolean THEN $4 ELSE default_reply_to END, status = coalesce($5, status) WHERE id = $1 RETURNING *`,
        [id, b.name ?? null, b.default_reply_to !== undefined, b.default_reply_to ?? null, b.status ?? null],
      );
    });
    r.delete('/v1/senders/:id', async (req) => {
      requirePlatform(req);
      const { id } = z.object({ id: uuid }).parse(req.params);
      await owned('senders', id, req.auth.account.id, 'השולח');
      for (const d of await query('SELECT * FROM domains WHERE sender_id = $1', [id])) await deleteDomain(d);
      await query('DELETE FROM senders WHERE id = $1', [id]);
      return { ok: true };
    });

    /** Shows what would happen when sending from an address, without sending. Useful for Retzef's settings screen. */
    r.post('/v1/senders/resolve', async (req) => {
      const b = z.object({ sender_id: uuid.nullish(), from: z.object({ email, name: z.string().nullish() }), fallback: z.enum(['platform', 'reject']).default('platform') }).parse(req.body);
      try {
        const res = await resolveFrom(req.auth.account, b.sender_id ?? null, b.from, b.fallback);
        return { ok: true, from_email: res.fromEmail, from_name: res.fromName, used_fallback: res.usedFallback };
      } catch (err: any) {
        if (err instanceof ApiError) return { ok: false, code: err.code, message: err.message };
        throw err;
      }
    });

    // ---------- Domains ----------
    const domainBody = z.object({ name: z.string().min(3).max(253), sender_id: uuid.nullish() });
    async function createDomainFor(req: any, senderId: string | null, name: string) {
      if (senderId) {
        requirePlatform(req);
        await owned('senders', senderId, req.auth.account.id, 'השולח');
      }
      return addDomain(req.auth.account.id, senderId, name);
    }
    r.get('/v1/domains', async (req) => {
      const q = page.extend({ sender_id: uuid.optional() }).parse(req.query);
      const rows = await query(
        `SELECT * FROM domains WHERE account_id = $1 AND ($2::uuid IS NULL OR sender_id = $2) ORDER BY created_at DESC LIMIT $3 OFFSET $4`,
        [req.auth.account.id, q.sender_id ?? null, q.limit, q.offset],
      );
      return rows.map(publicDomain);
    });
    r.post('/v1/domains', async (req, reply) => {
      const b = domainBody.parse(req.body);
      reply.code(201);
      return createDomainFor(req, b.sender_id ?? null, b.name);
    });
    r.post('/v1/senders/:id/domains', async (req, reply) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const b = z.object({ name: z.string().min(3).max(253) }).parse(req.body);
      reply.code(201);
      return createDomainFor(req, id, b.name);
    });
    r.get('/v1/domains/:id', async (req) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const row = await owned('domains', id, req.auth.account.id, 'הדומיין');
      return { ...publicDomain(row), bimi: await bimiStatus(row) };
    });

    /**
     * Adds the domain's records to Cloudflare DNS automatically, then verifies.
     * The customer's token is used for this request only and never stored.
     */
    r.post('/v1/domains/:id/cloudflare', async (req) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const row = await owned('domains', id, req.auth.account.id, 'הדומיין');
      const b = z.object({ token: z.string().trim().min(20).max(200).optional(), use_operator: z.boolean().optional() }).parse(req.body ?? {});
      let token = b.token;
      if (!token && b.use_operator) {
        if (!(await canUseOperatorCloudflare(req))) throw new ApiError(403, 'forbidden', 'החיבור של המערכת ל-Cloudflare זמין רק לדומיינים של המפעיל');
        token = config.cloudflareToken;
      }
      if (!token) throw new ApiError(400, 'cloudflare_token_required', 'צריך מפתח API של Cloudflare');
      const out = await applyRecords(token, row.name, row.records);
      // Cloudflare usually serves new records within seconds; check right away (the worker keeps checking).
      const checked = await checkDomain(row);
      if (checked.status === 'verified' && req.auth.account.trust_level === 0) await runAutoTrust();
      const fresh = await one('SELECT * FROM domains WHERE id = $1', [id]);
      return { zone: out.zone, results: out.results, domain: { ...publicDomain(fresh), bimi: await bimiStatus(fresh) } };
    });

    /** Domain Connect: is one-click setup available at this domain's DNS provider? */
    r.get('/v1/domains/:id/domain-connect', async (req) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const row = await owned('domains', id, req.auth.account.id, 'הדומיין');
      const plan = applyParams(row);
      if (!plan) return { available: false, reason: 'nothing_to_add' };
      const found = await discover(row.name);
      if (!found) return { available: false, reason: 'provider_not_supported' };
      const supported = await templateSupported(found.settings, plan.serviceId);
      return {
        available: supported,
        provider: found.settings.providerDisplayName || found.settings.providerName,
        zone: found.zone,
        reason: supported ? null : 'template_pending_approval',
      };
    });
    /** Returns the signed URL that takes the customer to their DNS provider to approve the records. */
    r.post('/v1/domains/:id/domain-connect', async (req) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const row = await owned('domains', id, req.auth.account.id, 'הדומיין');
      const found = await discover(row.name);
      if (!found) throw new ApiError(400, 'domain_connect_unavailable', 'ספק ה-DNS של הדומיין לא תומך בחיבור בלחיצה. אפשר להשתמש במפתח API או בקובץ DNS');
      const url = await applyUrl(row, found.zone, found.settings);
      if (!url) throw new ApiError(400, 'nothing_to_add', 'כל הרשומות כבר מאומתות');
      return { url, provider: found.settings.providerDisplayName || found.settings.providerName };
    });

    /** BIMI: upload the sender logo (SVG Tiny PS) and optionally a VMC/CMC certificate. */
    r.put('/v1/domains/:id/bimi', async (req) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const row = await owned('domains', id, req.auth.account.id, 'הדומיין');
      const b = z.object({ svg: z.string().min(20).max(64_000), certificate: z.string().max(64_000).nullish() }).parse(req.body);
      const errors = [...validateBimiSvg(b.svg), ...(b.certificate ? validateCertificate(b.certificate) : [])];
      if (errors.length) throw new ApiError(400, 'invalid_bimi', errors.join(' · '), { errors });
      const name = `default._bimi.${row.name}`;
      // A domain with no DMARC record yet gets a suggestion strict enough for BIMI
      const records = (row.records as any[])
        .filter((r) => r.purpose !== 'bimi')
        .map((r) => (r.purpose === 'dmarc' && r.status !== 'verified' ? { ...r, value: 'v=DMARC1; p=quarantine; pct=100; adkim=r; aspf=r' } : r));
      records.push({ type: 'TXT', name, value: bimiRecordValue(row.name, !!b.certificate), purpose: 'bimi', status: 'pending' });
      await query(`UPDATE domains SET bimi_svg = $2, bimi_certificate = $3, records = $4 WHERE id = $1`, [id, b.svg.trim(), b.certificate?.trim() || null, JSON.stringify(records)]);
      const fresh = await one('SELECT * FROM domains WHERE id = $1', [id]);
      await checkDomain(fresh);
      const after = await one('SELECT * FROM domains WHERE id = $1', [id]);
      return { ...publicDomain(after), bimi: await bimiStatus(after) };
    });
    r.delete('/v1/domains/:id/bimi', async (req) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const row = await owned('domains', id, req.auth.account.id, 'הדומיין');
      const records = (row.records as any[]).filter((r) => r.purpose !== 'bimi');
      await query(`UPDATE domains SET bimi_svg = NULL, bimi_certificate = NULL, records = $2 WHERE id = $1`, [id, JSON.stringify(records)]);
      return { ok: true };
    });
    /** DNS records as a zone file for import (Cloudflare: DNS → Records → Import and Export). */
    r.get('/v1/domains/:id/zone', async (req, reply) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const row = await owned('domains', id, req.auth.account.id, 'הדומיין');
      reply.header('content-type', 'text/plain; charset=utf-8').header('content-disposition', `attachment; filename="dns-${row.name}.txt"`);
      return zoneFile(row);
    });
    r.post('/v1/domains/:id/verify', async (req) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const checked = await checkDomain(await owned('domains', id, req.auth.account.id, 'הדומיין'));
      if (checked.status === 'verified' && req.auth.account.trust_level === 0) await runAutoTrust();
      const row = await one('SELECT * FROM domains WHERE id = $1', [id]);
      return { ...checked, bimi: await bimiStatus(row) };
    });
    r.delete('/v1/domains/:id', async (req) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      await deleteDomain(await owned('domains', id, req.auth.account.id, 'הדומיין'));
      return { ok: true };
    });

    // ---------- Direct emails ----------
    r.post('/v1/emails', async (req, reply) => {
      const b = sendSchema.parse(req.body);
      const idem = (req.headers['idempotency-key'] as string | undefined) ?? null;
      const res = await enqueueEmail(req.auth.account, { ...b, idempotency_key: idem, test: req.auth.testMode });
      reply.code(res.duplicate ? 200 : 202);
      return {
        duplicate: res.duplicate,
        test: req.auth.testMode,
        used_fallback: res.messages[0]?.used_fallback ?? false,
        from_email: res.messages[0]?.from_email,
        warnings: res.warnings,
        messages: res.messages.map((m: any) => ({
          id: m.id,
          to: m.to_email,
          ...(m.cc?.length || m.bcc?.length ? { to_list: m.to_list, cc: m.cc, bcc: m.bcc } : {}),
          message_id_header: m.message_id_header,
          status: m.status,
        })),
      };
    });
    r.get('/v1/emails', async (req) => {
      const q = page.extend({ status: z.string().optional(), to: z.string().optional(), sender_id: uuid.optional() }).parse(req.query);
      return query(
        `SELECT id, sender_id, campaign_id, kind, to_email, cc, bcc, from_email, from_name, subject, status, used_fallback, last_error, message_id_header, test, metadata, opened_at, clicked_at, sent_at, created_at
         FROM messages WHERE account_id = $1 AND campaign_id IS NULL AND ($2::text IS NULL OR status = $2) AND ($3::text IS NULL OR to_email = lower($3))
           AND ($4::uuid IS NULL OR sender_id = $4)
         ORDER BY created_at DESC LIMIT $5 OFFSET $6`,
        [req.auth.account.id, q.status ?? null, q.to ?? null, q.sender_id ?? null, q.limit, q.offset],
      );
    });
    r.get('/v1/emails/:id', async (req) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const m = await one(
        `SELECT id, sender_id, campaign_id, kind, to_email, to_list, cc, bcc, from_email, from_name, reply_to, subject, status, used_fallback, attempts, last_error,
           message_id_header, test, metadata, opened_at, clicked_at, sent_at, created_at FROM messages WHERE id = $1 AND account_id = $2`,
        [id, req.auth.account.id],
      );
      if (!m) throw notFound('המייל');
      const events = await query('SELECT type, data, created_at FROM events WHERE message_id = $1 ORDER BY id', [id]);
      const recipients = await query('SELECT email, kind, status, detail, updated_at FROM message_recipients WHERE message_id = $1 ORDER BY kind DESC, email', [id]);
      return { ...m, recipients, events };
    });

    // ---------- Contacts ----------
    const contactBody = z.object({
      email,
      name: z.preprocess(blank, z.string().max(200).nullish()),
      attributes: z.record(z.unknown()).default({}),
      consent_source: z.preprocess(blank, z.string().max(200).nullish()),
      list_ids: z.preprocess((v) => (Array.isArray(v) ? v.filter((x) => blank(x) !== undefined) : v), z.array(uuid).default([])),
    });
    r.get('/v1/contacts', async (req) => {
      const q = page
        .extend({
          search: z.preprocess(blank, z.string().optional()),
          email: z.preprocess(blank, email.optional()),
          list_id: z.preprocess(blank, uuid.optional()),
          status: z.preprocess(blank, z.string().optional()),
        })
        .parse(req.query);
      const rows = await query(
        `SELECT c.*, count(*) OVER() AS total FROM contacts c
         WHERE c.account_id = $1 AND ($2::text IS NULL OR c.email ILIKE '%' || $2 || '%' OR c.name ILIKE '%' || $2 || '%')
           AND ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM list_members lm WHERE lm.contact_id = c.id AND lm.list_id = $3))
           AND ($4::text IS NULL OR c.status = $4) AND ($7::text IS NULL OR c.email = $7)
         ORDER BY c.created_at DESC LIMIT $5 OFFSET $6`,
        [req.auth.account.id, q.search ?? null, q.list_id ?? null, q.status ?? null, q.limit, q.offset, q.email ?? null],
      );
      return { total: Number(rows[0]?.total ?? 0), items: rows.map(({ total, ...c }) => c) };
    });
    async function upsertContact(accountId: string, c: z.infer<typeof contactBody>, ip: string | null, client?: any) {
      const run = (sql: string, p: unknown[]) => (client ? client.query(sql, p).then((r: any) => r.rows) : query(sql, p));
      const [row] = await run(
        `INSERT INTO contacts (account_id, email, name, attributes, consent_source, consent_at, consent_ip)
         VALUES ($1, $2, $3, $4, $5, CASE WHEN $5::text IS NULL THEN NULL ELSE now() END, $6)
         ON CONFLICT (account_id, email) DO UPDATE SET name = coalesce(EXCLUDED.name, contacts.name),
           attributes = contacts.attributes || EXCLUDED.attributes, updated_at = now()
         RETURNING *, (xmax = 0) AS inserted`,
        [accountId, c.email, c.name ?? null, JSON.stringify(c.attributes), c.consent_source ?? null, ip],
      );
      const addedTo: string[] = [];
      for (const listId of c.list_ids) {
        const added = await run(
          `INSERT INTO list_members (list_id, contact_id, status) SELECT $1, $2, 'confirmed' FROM lists WHERE id = $1 AND account_id = $3 ON CONFLICT DO NOTHING RETURNING list_id`,
          [listId, row.id, accountId],
        );
        if (added.length) addedTo.push(listId);
      }
      return { row, addedTo };
    }
    async function contactLists(contactId: string) {
      return query('SELECT l.id, l.name, lm.status FROM list_members lm JOIN lists l ON l.id = lm.list_id WHERE lm.contact_id = $1 ORDER BY l.name', [contactId]);
    }
    /** Create or update by email. 201 when created, 200 when the contact already existed. */
    r.post('/v1/contacts', async (req, reply) => {
      const accountId = req.auth.account.id;
      const { row, addedTo } = await upsertContact(accountId, contactBody.parse(req.body), req.ip);
      const { inserted, ...c } = row;
      await emitEvent(accountId, inserted ? 'contact.created' : 'contact.updated', { contact: contactPayload(c) });
      for (const listId of addedTo) await emitEvent(accountId, 'contact.added_to_list', { contact: contactPayload(c), list_id: listId });
      reply.code(inserted ? 201 : 200);
      return { ...c, created: inserted, lists: await contactLists(c.id) };
    });
    r.post('/v1/contacts/import', async (req) => {
      const b = z
        .object({
          // Each email is checked below, so one bad address skips that row instead of failing the whole import
          contacts: z.array(contactBody.omit({ list_ids: true, consent_source: true }).extend({ email: z.string().max(320) })).min(1).max(10_000),
          list_ids: z.array(uuid).default([]),
          consent_source: z.string().min(3, 'צריך לציין מאיפה הגיעה הסכמת הנמענים'),
          consent_declared: z.literal(true, { errorMap: () => ({ message: 'צריך לאשר שכל הנמענים הסכימו לקבל דיוור' }) }),
        })
        .parse(req.body);
      const accountId = req.auth.account.id;
      const valid: (typeof b.contacts)[number][] = [];
      const skipped: string[] = [];
      const seen = new Set<string>();
      for (const c of b.contacts) {
        const e = email.safeParse(c.email);
        if (!e.success) { skipped.push(c.email); continue; }
        if (seen.has(e.data)) continue;
        seen.add(e.data);
        valid.push({ ...c, email: e.data });
      }
      if (!valid.length) throw new ApiError(400, 'no_valid_emails', 'לא נמצאו כתובות מייל תקינות');
      // Bulk imports don't fire contact.* webhooks (thousands of calls to Zapier/Make)
      const count = await tx(async (client) => {
        for (const c of valid) await upsertContact(accountId, { ...c, list_ids: b.list_ids, consent_source: b.consent_source }, req.ip, client);
        return valid.length;
      });
      return { imported: count, skipped_count: skipped.length, skipped: skipped.slice(0, 50) };
    });
    const contactRef = z.object({ id: z.string().min(1).max(320) });
    r.get('/v1/contacts/:id', async (req) => {
      const c = await findContact(contactRef.parse(req.params).id, req.auth.account.id);
      return { ...c, lists: await contactLists(c.id) };
    });
    r.patch('/v1/contacts/:id', async (req) => {
      const accountId = req.auth.account.id;
      const cur = await findContact(contactRef.parse(req.params).id, accountId);
      const b = z
        .object({
          email: z.preprocess(blank, email.optional()),
          name: z.preprocess(blank, z.string().max(200).nullish()),
          attributes: z.record(z.unknown()).optional(),
          /** true replaces attributes; by default the given keys are merged in */
          replace_attributes: z.boolean().default(false),
          status: z.preprocess(blank, z.enum(['active', 'unsubscribed']).optional()),
          consent_source: z.preprocess(blank, z.string().max(200).optional()),
          add_list_ids: z.array(uuid).default([]),
          remove_list_ids: z.array(uuid).default([]),
        })
        .parse(req.body ?? {});
      if (b.email && b.email !== cur.email) {
        const taken = await one('SELECT 1 FROM contacts WHERE account_id = $1 AND email = $2', [accountId, b.email]);
        if (taken) throw new ApiError(409, 'email_taken', 'כבר יש איש קשר עם הכתובת הזו');
      }
      if (b.status === 'active' && cur.status !== 'active') {
        if (cur.status !== 'unsubscribed') throw new ApiError(409, 'cannot_resubscribe', 'אי אפשר להחזיר כתובת שחזרה (bounce) או שהתלוננה על ספאם');
        if (!b.consent_source || b.consent_source.trim().length < 3) throw new ApiError(400, 'consent_required', 'כדי להחזיר מנוי שהוסר צריך לציין מאיפה הגיעה ההסכמה החדשה (consent_source)');
      }
      let c = await one(
        `UPDATE contacts SET email = coalesce($2, email), name = CASE WHEN $3::boolean THEN $4 ELSE name END,
           attributes = CASE WHEN $5::jsonb IS NULL THEN attributes WHEN $6 THEN $5::jsonb ELSE attributes || $5::jsonb END, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [cur.id, b.email ?? null, b.name !== undefined, b.name ?? null, b.attributes ? JSON.stringify(b.attributes) : null, b.replace_attributes],
      );
      if (b.status === 'unsubscribed' && cur.status === 'active') {
        await unsubscribeContact(accountId, c.email);
      } else if (b.status === 'active' && cur.status === 'unsubscribed') {
        await query(`DELETE FROM suppressions WHERE account_id = $1 AND email = $2 AND reason = 'unsubscribe'`, [accountId, c.email]);
        await query(`UPDATE contacts SET status = 'active', consent_source = $2, consent_at = now(), consent_ip = $3, updated_at = now() WHERE id = $1`, [c.id, b.consent_source, req.ip]);
        await query(`UPDATE list_members SET status = 'confirmed' WHERE contact_id = $1 AND status = 'unsubscribed'`, [c.id]);
      }
      for (const listId of b.add_list_ids) {
        const added = await query(
          `INSERT INTO list_members (list_id, contact_id, status) SELECT $1, $2, 'confirmed' FROM lists WHERE id = $1 AND account_id = $3 ON CONFLICT DO NOTHING RETURNING list_id`,
          [listId, c.id, accountId],
        );
        if (added.length) await emitEvent(accountId, 'contact.added_to_list', { contact: contactPayload(c), list_id: listId });
      }
      for (const listId of b.remove_list_ids) {
        const removed = await query(
          `DELETE FROM list_members lm USING lists l WHERE lm.list_id = $1 AND lm.contact_id = $2 AND l.id = lm.list_id AND l.account_id = $3 RETURNING lm.list_id`,
          [listId, c.id, accountId],
        );
        if (removed.length) await emitEvent(accountId, 'contact.removed_from_list', { contact: contactPayload(c), list_id: listId });
      }
      c = await one('SELECT * FROM contacts WHERE id = $1', [c.id]);
      await emitEvent(accountId, 'contact.updated', { contact: contactPayload(c) });
      return { ...c, lists: await contactLists(c.id) };
    });
    r.delete('/v1/contacts/:id', async (req) => {
      const accountId = req.auth.account.id;
      const c = await findContact(contactRef.parse(req.params).id, accountId);
      await query('DELETE FROM contacts WHERE id = $1', [c.id]);
      await emitEvent(accountId, 'contact.deleted', { contact: contactPayload(c) });
      return { ok: true };
    });

    // ---------- Lists ----------
    r.get('/v1/lists', async (req) =>
      query(
        `SELECT l.*, (SELECT count(*)::int FROM list_members lm WHERE lm.list_id = l.id AND lm.status = 'confirmed') AS members
         FROM lists l WHERE account_id = $1 ORDER BY created_at DESC`,
        [req.auth.account.id],
      ),
    );
    const listBody = z.object({
      name: z.string().min(1).max(120),
      description: z.string().max(500).nullish(),
      double_opt_in: z.boolean().default(true),
      from_email: email.nullish(),
      from_name: z.string().max(120).nullish(),
    });
    r.post('/v1/lists', async (req, reply) => {
      const b = listBody.parse(req.body);
      reply.code(201);
      return one(`INSERT INTO lists (account_id, name, description, double_opt_in, from_email, from_name) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [
        req.auth.account.id, b.name, b.description ?? null, b.double_opt_in, b.from_email ?? null, b.from_name ?? null,
      ]);
    });
    r.patch('/v1/lists/:id', async (req) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const cur = await owned('lists', id, req.auth.account.id, 'הרשימה');
      const b = listBody.partial().parse(req.body);
      const m = { ...cur, ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)) };
      return one(`UPDATE lists SET name=$2, description=$3, double_opt_in=$4, from_email=$5, from_name=$6 WHERE id=$1 RETURNING *`, [
        id, m.name, m.description, m.double_opt_in, m.from_email, m.from_name,
      ]);
    });
    r.delete('/v1/lists/:id', async (req) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      await owned('lists', id, req.auth.account.id, 'הרשימה');
      await query('DELETE FROM lists WHERE id = $1', [id]);
      return { ok: true };
    });
    /** Adds existing contacts by id or email. Unknown emails are returned in not_found (create them with POST /v1/contacts). */
    r.post('/v1/lists/:id/members', async (req) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const accountId = req.auth.account.id;
      await owned('lists', id, accountId, 'הרשימה');
      const b = z
        .object({ contact_ids: z.array(uuid).max(10_000).default([]), emails: z.array(email).max(10_000).default([]) })
        .refine((v) => v.contact_ids.length + v.emails.length > 0, 'צריך לשלוח contact_ids או emails')
        .parse(req.body);
      const found = await query<{ id: string; email: string }>(
        `SELECT id, email FROM contacts WHERE account_id = $1 AND (id = ANY($2::uuid[]) OR email = ANY($3::text[]))`,
        [accountId, b.contact_ids, b.emails],
      );
      const rows = await query(
        `INSERT INTO list_members (list_id, contact_id, status) SELECT $1, unnest($2::uuid[]), 'confirmed' ON CONFLICT DO NOTHING RETURNING contact_id`,
        [id, found.map((c) => c.id)],
      );
      const addedIds = new Set(rows.map((r: any) => r.contact_id));
      if (addedIds.size <= 100) {
        for (const c of await query('SELECT * FROM contacts WHERE id = ANY($1)', [[...addedIds]]))
          await emitEvent(accountId, 'contact.added_to_list', { contact: contactPayload(c), list_id: id });
      }
      const known = new Set(found.map((c) => c.email));
      return { added: rows.length, not_found: b.emails.filter((e) => !known.has(e)) };
    });
    r.delete('/v1/lists/:id/members/:contactId', async (req) => {
      const p = z.object({ id: uuid, contactId: z.string().min(1).max(320) }).parse(req.params);
      const accountId = req.auth.account.id;
      await owned('lists', p.id, accountId, 'הרשימה');
      const c = await findContact(p.contactId, accountId);
      const removed = await query('DELETE FROM list_members WHERE list_id = $1 AND contact_id = $2 RETURNING contact_id', [p.id, c.id]);
      if (removed.length) await emitEvent(accountId, 'contact.removed_from_list', { contact: contactPayload(c), list_id: p.id });
      return { ok: true, removed: removed.length > 0 };
    });

    // ---------- Templates ----------
    const templateBody = z.object({ name: z.string().min(1).max(120), subject: z.string().max(998).default(''), html: z.string().max(2_000_000).default(''), text: z.string().nullish() });
    r.get('/v1/templates', async (req) => query('SELECT * FROM templates WHERE account_id = $1 ORDER BY updated_at DESC', [req.auth.account.id]));
    r.post('/v1/templates', async (req, reply) => {
      const b = templateBody.parse(req.body);
      reply.code(201);
      return one('INSERT INTO templates (account_id, name, subject, html, text) VALUES ($1,$2,$3,$4,$5) RETURNING *', [req.auth.account.id, b.name, b.subject, b.html, b.text ?? null]);
    });
    r.get('/v1/templates/:id', async (req) => owned('templates', z.object({ id: uuid }).parse(req.params).id, req.auth.account.id, 'התבנית'));
    r.patch('/v1/templates/:id', async (req) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const cur = await owned('templates', id, req.auth.account.id, 'התבנית');
      const b = templateBody.partial().parse(req.body);
      const m = { ...cur, ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)) };
      return one('UPDATE templates SET name=$2, subject=$3, html=$4, text=$5, updated_at=now() WHERE id=$1 RETURNING *', [id, m.name, m.subject, m.html, m.text]);
    });
    r.delete('/v1/templates/:id', async (req) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      await owned('templates', id, req.auth.account.id, 'התבנית');
      await query('DELETE FROM templates WHERE id = $1', [id]);
      return { ok: true };
    });

    // ---------- Campaigns ----------
    const campaignBody = z.object({
      name: z.string().min(1).max(200),
      subject: z.string().min(1).max(998),
      from_name: z.string().min(1).max(120),
      from_email: email,
      reply_to: email.nullish(),
      sender_id: uuid.nullish(),
      html: z.string().max(2_000_000).default(''),
      text: z.string().nullish(),
      template_id: uuid.nullish(),
      is_advertisement: z.boolean().optional(),
      list_ids: z.array(uuid).default([]),
      /** 'inforu' sends through the account's InforUMobile packages (Settings → InforU) */
      channel: z.enum(['ses', 'inforu']).optional(),
      /** InforU contact groups (GroupId) to send to, for channel inforu */
      inforu_group_ids: z.array(z.coerce.number().int()).max(50).optional(),
    });
    /** Turns group ids into {id, name, recipients} from InforU, so the campaign shows what was chosen */
    async function resolveInforuGroups(account: any, ids?: number[]) {
      if (ids === undefined) return undefined;
      if (!ids.length) return [];
      const creds = inforuCredentials(account);
      if (!creds) throw new ApiError(400, 'inforu_not_connected', 'כדי לשלוח לקבוצות InforU מחברים קודם את חשבון ה-InforU בהגדרות החשבון');
      let all;
      try { all = await inforuGroups(creds); } catch (err: any) { throw new ApiError(502, 'inforu_error', String(err?.message ?? err)); }
      return ids.map((id) => {
        const g = all.find((x) => x.id === id);
        if (!g) throw new ApiError(400, 'inforu_group_not_found', `קבוצה ${id} לא נמצאה ב-InforU`);
        return { id: g.id, name: g.name, recipients: g.recipients };
      });
    }
    function checkChannel(account: any, channel?: string) {
      if (channel === 'inforu' && !(account.inforu_username && account.inforu_token_enc))
        throw new ApiError(400, 'inforu_not_connected', 'כדי לשלוח דרך InforU מחברים קודם את חשבון ה-InforU בהגדרות החשבון');
    }
    async function setLists(campaignId: string, accountId: string, listIds: string[]) {
      await query('DELETE FROM campaign_lists WHERE campaign_id = $1', [campaignId]);
      if (listIds.length)
        await query(`INSERT INTO campaign_lists (campaign_id, list_id) SELECT $1, id FROM lists WHERE id = ANY($2) AND account_id = $3`, [campaignId, listIds, accountId]);
    }
    async function campaignView(id: string) {
      const c = await one('SELECT * FROM campaigns WHERE id = $1', [id]);
      const lists = await query('SELECT l.id, l.name FROM campaign_lists cl JOIN lists l ON l.id = cl.list_id WHERE cl.campaign_id = $1', [id]);
      return { ...c, lists, stats: await campaignStats(id) };
    }
    r.get('/v1/campaigns', async (req) => {
      const q = page.parse(req.query);
      return query('SELECT id, name, subject, status, paused_reason, scheduled_at, started_at, finished_at, created_at FROM campaigns WHERE account_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3', [
        req.auth.account.id, q.limit, q.offset,
      ]);
    });
    r.post('/v1/campaigns', async (req, reply) => {
      const b = campaignBody.parse(req.body);
      checkChannel(req.auth.account, b.channel);
      const iuGroups = b.channel === 'inforu' ? await resolveInforuGroups(req.auth.account, b.inforu_group_ids) : undefined;
      let { html, text, subject } = b;
      if (b.template_id) {
        const t = await owned('templates', b.template_id, req.auth.account.id, 'התבנית');
        html = html || t.html;
        text = text ?? t.text;
        subject = subject || t.subject;
      }
      const c = await one(
        `INSERT INTO campaigns (account_id, sender_id, name, subject, from_name, from_email, reply_to, html, text, is_advertisement, channel, inforu_groups)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [req.auth.account.id, b.sender_id ?? null, b.name, subject, b.from_name, b.from_email, b.reply_to ?? null, html, text ?? null, b.is_advertisement ?? req.auth.account.ad_label_default, b.channel ?? 'ses', JSON.stringify(iuGroups ?? [])],
      );
      await setLists(c.id, req.auth.account.id, b.list_ids);
      reply.code(201);
      return campaignView(c.id);
    });
    r.get('/v1/campaigns/:id', async (req) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      await owned('campaigns', id, req.auth.account.id, 'הדיוור');
      return campaignView(id);
    });
    r.patch('/v1/campaigns/:id', async (req) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const cur = await owned('campaigns', id, req.auth.account.id, 'הדיוור');
      if (!['draft', 'scheduled', 'paused'].includes(cur.status)) throw new ApiError(409, 'campaign_locked', 'אי אפשר לערוך דיוור שכבר נשלח');
      const b = campaignBody.partial().parse(req.body);
      checkChannel(req.auth.account, b.channel);
      const m = { ...cur, ...Object.fromEntries(Object.entries(b).filter(([k, v]) => v !== undefined && k !== 'list_ids' && k !== 'template_id' && k !== 'inforu_group_ids')) };
      if (m.channel !== 'inforu') m.inforu_groups = [];
      else if (b.inforu_group_ids !== undefined) m.inforu_groups = await resolveInforuGroups(req.auth.account, b.inforu_group_ids);
      await query(
        `UPDATE campaigns SET name=$2, subject=$3, from_name=$4, from_email=$5, reply_to=$6, sender_id=$7, html=$8, text=$9, is_advertisement=$10, channel=$11, inforu_groups=$12, updated_at=now() WHERE id=$1`,
        [id, m.name, m.subject, m.from_name, m.from_email, m.reply_to, m.sender_id, m.html, m.text, m.is_advertisement, m.channel, JSON.stringify(m.inforu_groups ?? [])],
      );
      if (b.list_ids) await setLists(id, req.auth.account.id, b.list_ids);
      return campaignView(id);
    });
    r.delete('/v1/campaigns/:id', async (req) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const cur = await owned('campaigns', id, req.auth.account.id, 'הדיוור');
      if (cur.status !== 'draft') throw new ApiError(409, 'campaign_locked', 'אפשר למחוק רק טיוטה. דיוור אחר אפשר לבטל');
      await query('DELETE FROM campaigns WHERE id = $1', [id]);
      return { ok: true };
    });
    r.post('/v1/campaigns/:id/test', async (req) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const c = await owned('campaigns', id, req.auth.account.id, 'הדיוור');
      const b = z.object({ to: z.array(email).min(1).max(5) }).parse(req.body);
      if (c.channel === 'inforu') {
        checkChannel(req.auth.account, 'inforu');
        try {
          const r = await inforuTestSend(c, req.auth.account, b.to);
          return { channel: 'inforu', request_id: r.requestId, messages: b.to.map((to) => ({ to, status: 'sent' })) };
        } catch (err: any) {
          throw new ApiError(502, 'inforu_error', String(err?.message ?? err));
        }
      }
      const res = await enqueueEmail(req.auth.account, {
        sender_id: c.sender_id,
        from: { email: c.from_email, name: c.from_name },
        to: b.to,
        reply_to: c.reply_to,
        subject: `[בדיקה] ${c.is_advertisement ? 'פרסומת: ' : ''}${c.subject}`,
        html: c.html,
        text: c.text,
        type: 'marketing',
        ad_label: false, // the test subject above already carries the label when the campaign has it
        metadata: { test_of_campaign: c.id },
      });
      return { messages: res.messages.map((m: any) => ({ id: m.id, to: m.to_email, status: m.status })) };
    });
    r.post('/v1/campaigns/:id/send', async (req) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const c = await owned('campaigns', id, req.auth.account.id, 'הדיוור');
      const b = z.object({ scheduled_at: z.string().datetime().nullish() }).parse(req.body ?? {});
      if (!['draft', 'scheduled'].includes(c.status)) throw new ApiError(409, 'campaign_locked', 'הדיוור כבר נשלח או בתהליך שליחה');
      const acc = req.auth.account;
      if (acc.status !== 'active') throw new ApiError(403, 'account_pending', 'החשבון ממתין לאישור. עד האישור אפשר לשלוח רק מיילים בודדים ובדיקות');
      if (!acc.company_name || !acc.company_address) throw new ApiError(400, 'missing_legal_details', 'צריך למלא שם עסק וכתובת בהגדרות החשבון. החוק מחייב אותם בכל דיוור');
      if (!c.html && !c.text) throw new ApiError(400, 'empty_campaign', 'לדיוור אין תוכן');
      const lists = await query('SELECT 1 FROM campaign_lists WHERE campaign_id = $1', [id]);
      const hasIuGroups = c.channel === 'inforu' && (c.inforu_groups ?? []).length > 0;
      if (!lists.length && !hasIuGroups) throw new ApiError(400, 'no_lists', 'לא נבחרו רשימות יעד');
      // InforU checks the sender address against its own approved senders; SES needs a domain verified here
      if (c.channel === 'inforu') checkChannel(acc, 'inforu');
      else await resolveFrom(acc, c.sender_id, { email: c.from_email, name: c.from_name }, 'reject');
      await query(`UPDATE campaigns SET status = 'scheduled', scheduled_at = coalesce($2::timestamptz, now()), paused_reason = NULL, updated_at = now() WHERE id = $1`, [id, b.scheduled_at ?? null]);
      return campaignView(id);
    });
    r.post('/v1/campaigns/:id/pause', async (req) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const c = await owned('campaigns', id, req.auth.account.id, 'הדיוור');
      if (!['scheduled', 'sending'].includes(c.status)) throw new ApiError(409, 'invalid_state', 'אפשר להשהות רק דיוור מתוזמן או בשליחה');
      await query(`UPDATE campaigns SET status = 'paused', paused_reason = 'הושהה ידנית', updated_at = now() WHERE id = $1`, [id]);
      return campaignView(id);
    });
    r.post('/v1/campaigns/:id/resume', async (req) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const c = await owned('campaigns', id, req.auth.account.id, 'הדיוור');
      if (c.status !== 'paused') throw new ApiError(409, 'invalid_state', 'הדיוור לא מושהה');
      const started = await one('SELECT 1 FROM messages WHERE campaign_id = $1 LIMIT 1', [id]);
      await query(`UPDATE campaigns SET status = $2, paused_reason = NULL, updated_at = now() WHERE id = $1`, [id, started ? 'sending' : 'scheduled']);
      return campaignView(id);
    });
    r.post('/v1/campaigns/:id/cancel', async (req) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const c = await owned('campaigns', id, req.auth.account.id, 'הדיוור');
      if (['sent', 'cancelled'].includes(c.status)) throw new ApiError(409, 'invalid_state', 'הדיוור כבר הסתיים');
      await query(`UPDATE messages SET status = 'failed', last_error = 'campaign_cancelled' WHERE campaign_id = $1 AND status = 'queued'`, [id]);
      await query(`UPDATE campaigns SET status = 'cancelled', finished_at = now(), updated_at = now() WHERE id = $1`, [id]);
      return campaignView(id);
    });
    r.get('/v1/campaigns/:id/stats', async (req) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      await owned('campaigns', id, req.auth.account.id, 'הדיוור');
      return campaignStats(id);
    });

    /** Who got the campaign and what each recipient did. Filters match the stat cards. */
    const RECIPIENT_FILTERS: Record<string, string> = {
      all: 'true',
      sent: `m.status IN ('sent','delivered','bounced','complained')`,
      delivered: `m.status = 'delivered'`,
      sent_pending: `m.status = 'sent'`,
      opened: 'm.opened_at IS NOT NULL',
      not_opened: `m.opened_at IS NULL AND m.status IN ('sent','delivered')`,
      clicked: 'm.clicked_at IS NOT NULL',
      bounced: `m.status = 'bounced'`,
      complained: `m.status = 'complained'`,
      unsubscribed: `EXISTS (SELECT 1 FROM events e WHERE e.message_id = m.id AND e.type = 'unsubscribed')`,
      failed: `m.status IN ('failed','suppressed')`,
      queued: `m.status IN ('queued','sending')`,
    };
    const recipientsQuery = z.object({
      filter: z.enum(Object.keys(RECIPIENT_FILTERS) as [string, ...string[]]).default('all'),
      search: z.preprocess(blank, z.string().max(200).optional()),
    });
    async function campaignRecipients(campaignId: string, filter: string, search: string | undefined, limit: number, offset: number) {
      return query(
        `SELECT m.id AS message_id, m.to_email AS email, c.name, m.status, m.sent_at, m.opened_at, m.clicked_at, m.last_error,
           (SELECT count(*)::int FROM events e WHERE e.message_id = m.id AND e.type = 'opened') AS opens,
           (SELECT count(*)::int FROM events e WHERE e.message_id = m.id AND e.type = 'clicked') AS clicks,
           EXISTS (SELECT 1 FROM events e WHERE e.message_id = m.id AND e.type = 'unsubscribed') AS unsubscribed,
           count(*) OVER() AS total
         FROM messages m LEFT JOIN contacts c ON c.id = m.contact_id
         WHERE m.campaign_id = $1 AND NOT m.test AND ${RECIPIENT_FILTERS[filter]}
           AND ($2::text IS NULL OR m.to_email ILIKE '%' || $2 || '%' OR c.name ILIKE '%' || $2 || '%')
         ORDER BY m.clicked_at DESC NULLS LAST, m.opened_at DESC NULLS LAST, m.to_email
         LIMIT $3 OFFSET $4`,
        [campaignId, search ?? null, limit, offset],
      );
    }
    r.get('/v1/campaigns/:id/recipients', async (req) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      await owned('campaigns', id, req.auth.account.id, 'הדיוור');
      const q = page.merge(recipientsQuery).parse(req.query);
      const rows = await campaignRecipients(id, q.filter, q.search, q.limit, q.offset);
      return { total: Number(rows[0]?.total ?? 0), items: rows.map(({ total, ...r }: any) => r) };
    });
    /** The same list as a CSV file (Excel opens it in Hebrew thanks to the BOM) */
    r.get('/v1/campaigns/:id/recipients.csv', async (req, reply) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const c = await owned('campaigns', id, req.auth.account.id, 'הדיוור');
      const q = recipientsQuery.parse(req.query);
      const rows = await campaignRecipients(id, q.filter, q.search, 1_000_000, 0);
      const STATUS_HE: Record<string, string> = { queued: 'בתור', sending: 'בשליחה', sent: 'ממתין לאישור מסירה', delivered: 'נמסר', bounced: 'חזר', complained: 'תלונת ספאם', failed: 'נכשל', suppressed: 'חסום' };
      const cell = (v: unknown) => {
        const t = v == null ? '' : v instanceof Date ? v.toISOString().replace('T', ' ').slice(0, 19) : String(v);
        return /[",\n]/.test(t) || /^[=+\-@]/.test(t) ? `"${(/^[=+\-@]/.test(t) ? `'${t}` : t).replace(/"/g, '""')}"` : t;
      };
      const lines = [['מייל', 'שם', 'מצב', 'נשלח', 'נפתח לראשונה', 'פתיחות', 'הקלקה ראשונה', 'הקלקות', 'הסיר את עצמו', 'שגיאה'].join(',')];
      for (const r of rows as any[])
        lines.push([r.email, r.name, STATUS_HE[r.status] ?? r.status, r.sent_at, r.opened_at, r.opens, r.clicked_at, r.clicks, r.unsubscribed ? 'כן' : '', r.last_error].map(cell).join(','));
      const name = `${String(c.name).replace(/[^\p{L}\p{N} _-]/gu, '').trim() || 'campaign'}-${q.filter}.csv`;
      reply.header('content-type', 'text/csv; charset=utf-8');
      reply.header('content-disposition', `attachment; filename="campaign.csv"; filename*=UTF-8''${encodeURIComponent(name)}`);
      return '\uFEFF' + lines.join('\r\n') + '\r\n';
    });
    /** Clicks per link: total clicks and how many different recipients clicked it */
    r.get('/v1/campaigns/:id/links', async (req) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      await owned('campaigns', id, req.auth.account.id, 'הדיוור');
      return query(
        `SELECT e.data->>'url' AS url, count(*)::int AS clicks, count(DISTINCT e.message_id)::int AS unique_clicks
         FROM events e JOIN messages m ON m.id = e.message_id
         WHERE m.campaign_id = $1 AND NOT m.test AND e.type = 'clicked' AND e.data ? 'url'
         GROUP BY 1 ORDER BY unique_clicks DESC, clicks DESC LIMIT 100`,
        [id],
      );
    });
    /** Opens and clicks per hour since sending started (first 7 days) */
    r.get('/v1/campaigns/:id/timeline', async (req) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const c = await owned('campaigns', id, req.auth.account.id, 'הדיוור');
      if (!c.started_at) return [];
      return query(
        `SELECT floor(extract(epoch FROM e.created_at - $2::timestamptz) / 3600)::int AS hour,
           count(DISTINCT e.message_id) FILTER (WHERE e.type = 'opened')::int AS opened,
           count(DISTINCT e.message_id) FILTER (WHERE e.type = 'clicked')::int AS clicked
         FROM events e JOIN messages m ON m.id = e.message_id
         WHERE m.campaign_id = $1 AND NOT m.test AND e.type IN ('opened','clicked') AND e.created_at < $2::timestamptz + interval '7 days'
         GROUP BY 1 ORDER BY 1`,
        [id, c.started_at],
      );
    });

    // ---------- Suppressions (account level) ----------
    r.get('/v1/suppressions', async (req) => {
      const q = page.extend({ email: z.string().optional() }).parse(req.query);
      return query(`SELECT email, reason, created_at FROM suppressions WHERE account_id = $1 AND ($2::text IS NULL OR email = lower($2)) ORDER BY created_at DESC LIMIT $3 OFFSET $4`, [
        req.auth.account.id, q.email ?? null, q.limit, q.offset,
      ]);
    });
    r.post('/v1/suppressions', async (req, reply) => {
      const b = z.object({ email, reason: z.enum(['unsubscribe', 'manual']).default('manual') }).parse(req.body);
      await suppress(req.auth.account.id, b.email, b.reason);
      reply.code(201);
      return { ok: true };
    });
    r.delete('/v1/suppressions/:email', async (req) => {
      const { email: e } = z.object({ email }).parse(req.params);
      await query(`DELETE FROM suppressions WHERE account_id = $1 AND email = $2 AND reason IN ('unsubscribe', 'manual')`, [req.auth.account.id, e]);
      return { ok: true };
    });

    // ---------- Webhooks ----------
    r.get('/v1/webhooks', async (req) => query('SELECT id, url, events, active, created_at FROM webhooks WHERE account_id = $1', [req.auth.account.id]));
    r.post('/v1/webhooks', async (req, reply) => {
      const b = z.object({ url: z.string().url().startsWith('https://', 'הכתובת חייבת להתחיל ב-https://'), events: z.array(z.enum(WEBHOOK_EVENTS)).default([]) }).parse(req.body);
      reply.code(201);
      return one('INSERT INTO webhooks (account_id, url, secret, events) VALUES ($1,$2,$3,$4) RETURNING *', [req.auth.account.id, b.url, newWebhookSecret(), b.events]);
    });
    r.patch('/v1/webhooks/:id', async (req) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      await owned('webhooks', id, req.auth.account.id, 'ה-webhook');
      const b = z.object({ events: z.array(z.enum(WEBHOOK_EVENTS)).optional(), active: z.boolean().optional() }).parse(req.body);
      return one('UPDATE webhooks SET events = coalesce($2, events), active = coalesce($3, active) WHERE id = $1 RETURNING id, url, events, active', [id, b.events ?? null, b.active ?? null]);
    });
    r.delete('/v1/webhooks/:id', async (req) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      await query('DELETE FROM webhooks WHERE id = $1 AND account_id = $2', [id, req.auth.account.id]);
      return { ok: true };
    });

    // ---------- Super admin ----------
    r.get('/admin/accounts', async (req) => {
      requireSuperAdmin(req);
      return query(
        `SELECT a.*, (SELECT count(*)::int FROM messages m WHERE m.account_id = a.id AND m.created_at > now() - interval '30 days') AS sent_30d,
           (SELECT count(*)::int FROM messages m WHERE m.account_id = a.id AND m.status = 'bounced' AND m.created_at > now() - interval '30 days') AS bounced_30d,
           (SELECT count(*)::int FROM messages m WHERE m.account_id = a.id AND m.status = 'complained' AND m.created_at > now() - interval '30 days') AS complained_30d
         FROM accounts a ORDER BY created_at DESC`,
      );
    });
    /** Domain Connect registration status, for the operator. */
    r.get('/admin/domain-connect', async (req) => {
      requireSuperAdmin(req);
      const cf = await discover(DC_PROVIDER_ID);
      const list = templates();
      return {
        provider_id: DC_PROVIDER_ID,
        templates: await Promise.all(list.map(async (t) => ({
          file: `${DC_PROVIDER_ID}.${t.serviceId}.json`,
          service_id: t.serviceId,
          name: t.serviceName,
          cloudflare_supported: cf ? await templateSupported(cf.settings, t.serviceId) : false,
          json: t,
        }))),
        public_key_records: await publicKeyRecords(),
        public_key_published: await publicKeyPublished(),
      };
    });
    r.get('/admin/backups', async (req) => {
      requireSuperAdmin(req);
      const c = backupConfig();
      let backups: any[] = [];
      let listError: string | null = null;
      try {
        backups = await listBackups();
      } catch (err: any) {
        listError = err.message;
      }
      return { configured: backupConfigured(), bucket: c.bucket || null, hour: c.hour, retention_days: c.retentionDays, last: await backupStatus(), backups, list_error: listError };
    });
    r.post('/admin/backups/run', async (req) => {
      requireSuperAdmin(req);
      return runBackup('manual');
    });
    r.post('/admin/trust/run', async (req) => {
      requireSuperAdmin(req);
      await runAutoTrust();
      return { ok: true };
    });
    r.patch('/admin/accounts/:id', async (req) => {
      requireSuperAdmin(req);
      const { id } = z.object({ id: uuid }).parse(req.params);
      const b = z
        .object({
          status: z.enum(['pending', 'active', 'suspended']).optional(),
          type: z.enum(['standard', 'platform']).optional(),
          daily_limit: z.number().int().min(0).max(10_000_000).optional(),
          monthly_limit: z.number().int().min(0).nullish(),
          can_use_reserved_domains: z.boolean().optional(),
          auto_trust: z.boolean().optional(),
        })
        .parse(req.body);
      const row = await one(
        `UPDATE accounts SET status = coalesce($2, status), type = coalesce($3, type), daily_limit = coalesce($4, daily_limit),
           monthly_limit = CASE WHEN $5::boolean THEN $6 ELSE monthly_limit END,
           can_use_reserved_domains = coalesce($7, can_use_reserved_domains),
           trust_manual = CASE WHEN $8::boolean IS NULL THEN trust_manual ELSE $8 END,
           paused_reason = CASE WHEN $2 = 'active' THEN NULL ELSE paused_reason END
         WHERE id = $1 RETURNING *`,
        [id, b.status ?? null, b.type ?? null, b.daily_limit ?? null, b.monthly_limit !== undefined, b.monthly_limit ?? null, b.can_use_reserved_domains ?? null,
         b.auto_trust === undefined ? (b.daily_limit !== undefined ? true : null) : !b.auto_trust],
      );
      if (!row) throw notFound('החשבון');
      return row;
    });
  });
}
