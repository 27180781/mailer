import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { one, query, tx } from '../db.js';
import { hashPassword, verifyPassword, sha256 } from '../crypto.js';
import { ApiError, notFound } from '../errors.js';
import { authenticate, createApiKey, createSession, requirePlatform, requireSuperAdmin } from '../auth.js';
import { addDomain, checkDomain, deleteDomain, publicDomain, zoneFile } from '../services/domains.js';
import { bimiRecordValue, bimiStatus, validateBimiSvg, validateCertificate } from '../services/bimi.js';
import { enqueueEmail, resolveFrom, sentToday } from '../services/send.js';
import { campaignStats } from '../services/campaigns.js';
import { newWebhookSecret, WEBHOOK_EVENTS } from '../services/webhooks.js';
import { suppress } from '../services/suppression.js';
import { runAutoTrust, trustInfo } from '../services/trust.js';

const email = z.string().trim().toLowerCase().email('כתובת מייל לא תקינה');
const uuid = z.string().uuid('מזהה לא תקין');
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
    from: z.union([email.transform((e) => ({ email: e, name: null as string | null })), z.object({ email, name: z.string().max(120).nullish() })]),
    fallback: z.enum(['platform', 'reject']).default('reject'),
    reply_to: email.nullish(),
    to: z.union([email.transform((e) => [e]), z.array(email).min(1).max(50)]),
    cc: z.union([email.transform((e) => [e]), z.array(email).max(49)]).default([]),
    bcc: z.union([email.transform((e) => [e]), z.array(email).max(49)]).default([]),
    subject: z.string().min(1).max(998),
    html: z.string().max(2_000_000).nullish(),
    text: z.string().max(1_000_000).nullish(),
    type: z.enum(['transactional', 'marketing']).default('transactional'),
    attachments: z.array(attachment).max(10).default([]),
    headers: z
      .record(z.string().regex(/^(X-[A-Za-z0-9-]+|Message-ID|In-Reply-To|References)$/i, 'מותרות כותרות X-…, ו-Message-ID, In-Reply-To, References'), z.string().max(2000))
      .default({}),
    metadata: z.record(z.unknown()).default({}),
    scheduled_at: z.string().datetime().nullish(),
  })
  .refine((v) => v.html || v.text, { message: 'צריך html או text' })
  .refine((v) => v.attachments.reduce((n, a) => n + (a.content.length * 3) / 4, 0) <= MAX_ATTACHMENTS_BYTES, {
    message: 'גודל הקבצים המצורפים חורג מ-10MB',
  });

function publicAccount(a: any) {
  const { paused_reason, ...rest } = a;
  return { ...rest, paused_reason };
}

async function owned(table: string, id: string, accountId: string, what: string) {
  const row = await one(`SELECT * FROM ${table} WHERE id = $1 AND account_id = $2`, [id, accountId]);
  if (!row) throw notFound(what);
  return row;
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
      return { account, user };
    });
    reply.code(201);
    return { token: await createSession(result.user.id), account: publicAccount(result.account) };
  });

  app.post('/v1/auth/login', async (req) => {
    const b = z.object({ email, password: z.string() }).parse(req.body);
    const user = await one('SELECT * FROM users WHERE email = $1', [b.email]);
    if (!user || !(await verifyPassword(b.password, user.password_hash))) throw new ApiError(401, 'invalid_login', 'מייל או סיסמה שגויים');
    return { token: await createSession(user.id) };
  });

  // ---------- Everything below needs a token ----------
  app.register(async (r) => {
    r.addHook('preHandler', authenticate);

    r.post('/v1/auth/logout', async (req) => {
      const token = req.headers.authorization!.slice(7).trim();
      await query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
      return { ok: true };
    });

    r.get('/v1/me', async (req) => ({
      account: publicAccount(req.auth.account),
      user: req.auth.user && { id: req.auth.user.id, email: req.auth.user.email, name: req.auth.user.name, is_superadmin: req.auth.user.is_superadmin },
      usage: { today: await sentToday(req.auth.account.id), daily_limit: req.auth.account.daily_limit },
      trust: await trustInfo(req.auth.account),
      test_mode: req.auth.testMode,
    }));

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
      return { days, daily, totals, counts };
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

    /** BIMI: upload the sender logo (SVG Tiny PS) and optionally a VMC/CMC certificate. */
    r.put('/v1/domains/:id/bimi', async (req) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const row = await owned('domains', id, req.auth.account.id, 'הדומיין');
      const b = z.object({ svg: z.string().min(20).max(64_000), certificate: z.string().max(64_000).nullish() }).parse(req.body);
      const errors = [...validateBimiSvg(b.svg), ...(b.certificate ? validateCertificate(b.certificate) : [])];
      if (errors.length) throw new ApiError(400, 'invalid_bimi', errors.join(' · '), { errors });
      const name = `default._bimi.${row.name}`;
      const records = (row.records as any[]).filter((r) => r.purpose !== 'bimi');
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
      name: z.string().max(200).nullish(),
      attributes: z.record(z.unknown()).default({}),
      consent_source: z.string().max(200).nullish(),
      list_ids: z.array(uuid).default([]),
    });
    r.get('/v1/contacts', async (req) => {
      const q = page.extend({ search: z.string().optional(), list_id: uuid.optional(), status: z.string().optional() }).parse(req.query);
      const rows = await query(
        `SELECT c.*, count(*) OVER() AS total FROM contacts c
         WHERE c.account_id = $1 AND ($2::text IS NULL OR c.email ILIKE '%' || $2 || '%' OR c.name ILIKE '%' || $2 || '%')
           AND ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM list_members lm WHERE lm.contact_id = c.id AND lm.list_id = $3))
           AND ($4::text IS NULL OR c.status = $4)
         ORDER BY c.created_at DESC LIMIT $5 OFFSET $6`,
        [req.auth.account.id, q.search ?? null, q.list_id ?? null, q.status ?? null, q.limit, q.offset],
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
         RETURNING *`,
        [accountId, c.email, c.name ?? null, JSON.stringify(c.attributes), c.consent_source ?? null, ip],
      );
      for (const listId of c.list_ids) {
        await run(
          `INSERT INTO list_members (list_id, contact_id, status) SELECT $1, $2, 'confirmed' FROM lists WHERE id = $1 AND account_id = $3 ON CONFLICT DO NOTHING`,
          [listId, row.id, accountId],
        );
      }
      return row;
    }
    r.post('/v1/contacts', async (req, reply) => {
      reply.code(201);
      return upsertContact(req.auth.account.id, contactBody.parse(req.body), req.ip);
    });
    r.post('/v1/contacts/import', async (req) => {
      const b = z
        .object({
          contacts: z.array(contactBody.omit({ list_ids: true, consent_source: true })).min(1).max(10_000),
          list_ids: z.array(uuid).default([]),
          consent_source: z.string().min(3, 'צריך לציין מאיפה הגיעה הסכמת הנמענים'),
          consent_declared: z.literal(true, { errorMap: () => ({ message: 'צריך לאשר שכל הנמענים הסכימו לקבל דיוור' }) }),
        })
        .parse(req.body);
      const accountId = req.auth.account.id;
      const count = await tx(async (client) => {
        for (const c of b.contacts) await upsertContact(accountId, { ...c, list_ids: b.list_ids, consent_source: b.consent_source }, req.ip, client);
        return b.contacts.length;
      });
      return { imported: count };
    });
    r.get('/v1/contacts/:id', async (req) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const c = await owned('contacts', id, req.auth.account.id, 'איש הקשר');
      const lists = await query('SELECT l.id, l.name, lm.status FROM list_members lm JOIN lists l ON l.id = lm.list_id WHERE lm.contact_id = $1', [id]);
      return { ...c, lists };
    });
    r.patch('/v1/contacts/:id', async (req) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      await owned('contacts', id, req.auth.account.id, 'איש הקשר');
      const b = z.object({ name: z.string().max(200).nullish(), attributes: z.record(z.unknown()).optional() }).parse(req.body);
      return one(
        `UPDATE contacts SET name = CASE WHEN $2::boolean THEN $3 ELSE name END, attributes = coalesce($4, attributes), updated_at = now() WHERE id = $1 RETURNING *`,
        [id, b.name !== undefined, b.name ?? null, b.attributes ? JSON.stringify(b.attributes) : null],
      );
    });
    r.delete('/v1/contacts/:id', async (req) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      await owned('contacts', id, req.auth.account.id, 'איש הקשר');
      await query('DELETE FROM contacts WHERE id = $1', [id]);
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
    r.post('/v1/lists/:id/members', async (req) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      await owned('lists', id, req.auth.account.id, 'הרשימה');
      const b = z.object({ contact_ids: z.array(uuid).min(1).max(10_000) }).parse(req.body);
      const rows = await query(
        `INSERT INTO list_members (list_id, contact_id) SELECT $1, c.id FROM contacts c WHERE c.id = ANY($2) AND c.account_id = $3
         ON CONFLICT DO NOTHING RETURNING contact_id`,
        [id, b.contact_ids, req.auth.account.id],
      );
      return { added: rows.length };
    });
    r.delete('/v1/lists/:id/members/:contactId', async (req) => {
      const p = z.object({ id: uuid, contactId: uuid }).parse(req.params);
      await owned('lists', p.id, req.auth.account.id, 'הרשימה');
      await query('DELETE FROM list_members WHERE list_id = $1 AND contact_id = $2', [p.id, p.contactId]);
      return { ok: true };
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
      is_advertisement: z.boolean().default(true),
      list_ids: z.array(uuid).default([]),
    });
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
      let { html, text, subject } = b;
      if (b.template_id) {
        const t = await owned('templates', b.template_id, req.auth.account.id, 'התבנית');
        html = html || t.html;
        text = text ?? t.text;
        subject = subject || t.subject;
      }
      const c = await one(
        `INSERT INTO campaigns (account_id, sender_id, name, subject, from_name, from_email, reply_to, html, text, is_advertisement)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [req.auth.account.id, b.sender_id ?? null, b.name, subject, b.from_name, b.from_email, b.reply_to ?? null, html, text ?? null, b.is_advertisement],
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
      const m = { ...cur, ...Object.fromEntries(Object.entries(b).filter(([k, v]) => v !== undefined && k !== 'list_ids' && k !== 'template_id')) };
      await query(
        `UPDATE campaigns SET name=$2, subject=$3, from_name=$4, from_email=$5, reply_to=$6, sender_id=$7, html=$8, text=$9, is_advertisement=$10, updated_at=now() WHERE id=$1`,
        [id, m.name, m.subject, m.from_name, m.from_email, m.reply_to, m.sender_id, m.html, m.text, m.is_advertisement],
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
      const res = await enqueueEmail(req.auth.account, {
        sender_id: c.sender_id,
        from: { email: c.from_email, name: c.from_name },
        to: b.to,
        reply_to: c.reply_to,
        subject: `[בדיקה] ${c.is_advertisement ? 'פרסומת: ' : ''}${c.subject}`,
        html: c.html,
        text: c.text,
        type: 'marketing',
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
      if (!lists.length) throw new ApiError(400, 'no_lists', 'לא נבחרו רשימות יעד');
      await resolveFrom(acc, c.sender_id, { email: c.from_email, name: c.from_name }, 'reject');
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
