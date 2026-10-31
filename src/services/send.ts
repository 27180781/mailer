import { one, query } from '../db.js';
import { ApiError } from '../errors.js';
import { getProvider, ProviderError } from '../providers/index.js';
import { domainOf, domainOwnedElsewhere, findSendingDomain, FREEMAIL_DOMAINS } from './domains.js';
import { suppressionReason } from './suppression.js';
import { emitEvent } from './webhooks.js';
import {
  addTracking,
  advertisingFooter,
  advertisingSubject,
  buildRaw,
  insertFooter,
  listUnsubscribeHeaders,
  personalize,
  unsubscribeUrl,
  type Attachment,
} from './render.js';

export type FallbackMode = 'platform' | 'reject';

export interface ResolvedFrom {
  fromEmail: string;
  fromName: string | null;
  usedFallback: boolean;
  domain: any;
}

function fallbackName(account: any, name: string | null) {
  if (!name) return account.name;
  return account.fallback_name_template.replace('{{name}}', name).replace('{{account}}', account.name);
}

/**
 * Decides which address an email really goes out from.
 * The requested address is used only if its domain is verified for this account / sender.
 * Otherwise a platform account may fall back to its own no-reply address.
 */
export async function resolveFrom(account: any, senderId: string | null, from: { email: string; name?: string | null }, mode: FallbackMode): Promise<ResolvedFrom> {
  const email = from.email.trim().toLowerCase();
  const name = from.name?.trim() || null;
  const d = domainOf(email);

  if (!d) throw new ApiError(400, 'invalid_from', 'כתובת השולח לא תקינה');
  if (await domainOwnedElsewhere(account.id, senderId, email)) {
    throw new ApiError(403, 'domain_not_owned', 'הדומיין של כתובת השולח שייך לחשבון או לשולח אחר');
  }

  const domain = FREEMAIL_DOMAINS.has(d) ? null : await findSendingDomain(account.id, senderId, email);
  if (domain) return { fromEmail: email, fromName: name, usedFallback: false, domain };

  if (mode === 'platform') {
    if (account.type !== 'platform' || !account.fallback_from_email) {
      throw new ApiError(400, 'no_fallback', 'לחשבון לא הוגדרה כתובת גיבוי (fallback_from_email)');
    }
    const fb = await findSendingDomain(account.id, null, account.fallback_from_email);
    if (!fb) throw new ApiError(400, 'fallback_not_verified', 'הדומיין של כתובת הגיבוי עדיין לא מאומת');
    return { fromEmail: account.fallback_from_email, fromName: fallbackName(account, name), usedFallback: true, domain: fb };
  }
  if (FREEMAIL_DOMAINS.has(d)) {
    throw new ApiError(400, 'freemail_not_allowed', 'אי אפשר לשלוח מכתובת של ספק דואר חינמי (כמו Gmail). צריך כתובת בדומיין מאומת');
  }
  throw new ApiError(400, 'domain_not_verified', `הדומיין ${d} לא מאומת עבור השולח הזה`);
}

export async function sentToday(accountId: string): Promise<number> {
  const row = await one<{ n: string }>(
    `SELECT count(*) AS n FROM messages WHERE account_id = $1 AND created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Jerusalem') AT TIME ZONE 'Asia/Jerusalem'`,
    [accountId],
  );
  return Number(row?.n ?? 0);
}

export async function assertQuota(account: any, count: number) {
  if (account.status === 'suspended') throw new ApiError(403, 'account_suspended', 'החשבון מושעה');
  const used = await sentToday(account.id);
  if (used + count > account.daily_limit) {
    throw new ApiError(429, 'daily_limit_exceeded', `חריגה מהמכסה היומית (${account.daily_limit} מיילים). נשלחו היום ${used}`);
  }
}

export interface SendInput {
  sender_id?: string | null;
  from: { email: string; name?: string | null };
  fallback?: FallbackMode;
  reply_to?: string | null;
  to: string[];
  subject: string;
  html?: string | null;
  text?: string | null;
  type?: 'transactional' | 'marketing';
  attachments?: Attachment[];
  headers?: Record<string, string>;
  metadata?: Record<string, unknown>;
  idempotency_key?: string | null;
  scheduled_at?: string | null;
}

/** Validates and queues a direct (API) email. Returns one message per recipient. */
export async function enqueueEmail(account: any, input: SendInput) {
  const senderId = input.sender_id ?? null;
  if (senderId) {
    const sender = await one('SELECT * FROM senders WHERE id = $1 AND account_id = $2', [senderId, account.id]);
    if (!sender) throw new ApiError(404, 'sender_not_found', 'השולח לא נמצא');
    if (sender.status !== 'active') throw new ApiError(403, 'sender_suspended', 'השולח מושעה');
    input.reply_to ??= sender.default_reply_to;
  }

  if (input.idempotency_key) {
    const existing = await query(
      `SELECT id, to_email, status, used_fallback, from_email FROM messages WHERE account_id = $1 AND (idempotency_key = $2 OR idempotency_key LIKE $2 || ':%')`,
      [account.id, input.idempotency_key],
    );
    if (existing.length) return { duplicate: true, messages: existing };
  }

  await assertQuota(account, input.to.length);
  const resolved = await resolveFrom(account, senderId, input.from, input.fallback ?? 'reject');
  const kind = input.type ?? 'transactional';

  const messages = [];
  for (const [i, raw] of input.to.entries()) {
    const to = raw.trim().toLowerCase();
    const key = input.idempotency_key ? (input.to.length > 1 ? `${input.idempotency_key}:${i}` : input.idempotency_key) : null;
    const reason = await suppressionReason(account.id, to, kind);
    const row = await one(
      `INSERT INTO messages (account_id, sender_id, kind, priority, to_email, from_email, from_name, reply_to, subject, html, text,
         headers, attachments, used_fallback, status, idempotency_key, metadata, next_attempt_at, last_error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, coalesce($18::timestamptz, now()), $19)
       RETURNING id, to_email, status, used_fallback, from_email`,
      [
        account.id, senderId, kind, kind === 'transactional' ? 0 : 5, to, resolved.fromEmail, resolved.fromName, input.reply_to ?? null,
        input.subject, input.html ?? null, input.text ?? null, JSON.stringify(input.headers ?? {}),
        input.attachments?.length ? JSON.stringify(input.attachments) : null, resolved.usedFallback,
        reason ? 'suppressed' : 'queued', key, JSON.stringify({ ...(input.metadata ?? {}), fallback: input.fallback ?? 'reject' }),
        input.scheduled_at ?? null, reason ? `suppressed:${reason}` : null,
      ],
    );
    if (reason) await emitEvent(account.id, 'email.suppressed', { message_id: row.id, to, reason });
    messages.push(row);
  }
  return { duplicate: false, messages };
}

const RETRY_SECONDS = [60, 300, 1800];

/** Sends one claimed message. Called by the worker. */
export async function processMessage(msg: any) {
  const account = await one('SELECT * FROM accounts WHERE id = $1', [msg.account_id]);
  const fail = async (error: string, status = 'failed') => {
    await query(`UPDATE messages SET status = $2, last_error = $3 WHERE id = $1`, [msg.id, status, error]);
    await emitEvent(msg.account_id, status === 'suppressed' ? 'email.suppressed' : 'email.failed', { message_id: msg.id, to: msg.to_email, error, metadata: msg.metadata });
  };
  if (!account || account.status === 'suspended') return fail('account_suspended');

  const reason = await suppressionReason(account.id, msg.to_email, msg.kind);
  if (reason) return fail(`suppressed:${reason}`, 'suppressed');

  // The domain may have lost verification since the email was queued.
  let fromEmail = msg.from_email;
  let fromName = msg.from_name;
  let domain = await findSendingDomain(account.id, msg.used_fallback ? null : msg.sender_id, fromEmail);
  if (!domain) {
    if (msg.metadata?.fallback === 'platform' && !msg.used_fallback) {
      try {
        const r = await resolveFrom(account, msg.sender_id, { email: fromEmail, name: fromName }, 'platform');
        ({ fromEmail, fromName, domain } = r);
        await query(`UPDATE messages SET from_email = $2, from_name = $3, used_fallback = true WHERE id = $1`, [msg.id, fromEmail, fromName]);
      } catch (err: any) {
        return fail(err.code ?? 'domain_not_verified');
      }
    } else {
      return fail('domain_not_verified');
    }
  }

  let subject: string = msg.subject ?? '';
  let html: string | null = msg.html;
  let text: string | null = msg.text;
  const headers: Record<string, string> = { ...(msg.headers ?? {}) };
  let replyTo = msg.reply_to;
  const isMarketing = msg.kind !== 'transactional';

  if (msg.kind === 'campaign') {
    const campaign = await one('SELECT * FROM campaigns WHERE id = $1', [msg.campaign_id]);
    const contact = msg.contact_id ? await one('SELECT * FROM contacts WHERE id = $1', [msg.contact_id]) : null;
    const vars = { name: contact?.name ?? '', email: msg.to_email, attr: contact?.attributes ?? {} };
    subject = personalize(campaign.subject, vars, false);
    html = personalize(campaign.html, vars, true);
    text = campaign.text ? personalize(campaign.text, vars, false) : null;
    replyTo = campaign.reply_to;
    if (campaign.is_advertisement) subject = advertisingSubject(subject);
  }
  if (isMarketing && html) html = insertFooter(html, advertisingFooter(account, unsubscribeUrl(msg.id)));
  if (isMarketing) Object.assign(headers, listUnsubscribeHeaders(msg.id));
  if (html && (isMarketing || account.track_transactional)) html = addTracking(html, msg.id);

  const raw = await buildRaw({
    messageId: msg.id,
    domain: domain.name,
    fromEmail,
    fromName,
    to: msg.to_email,
    replyTo,
    subject,
    html,
    text,
    headers,
    attachments: msg.attachments,
  });

  const provider = getProvider(domain.provider);
  try {
    const out = await provider.send({
      id: msg.id,
      from: fromEmail,
      to: msg.to_email,
      raw,
      domain: domain.name,
      providerData: domain.provider_data,
      tags: { account: account.id, kind: msg.kind },
    });
    await query(
      `UPDATE messages SET status = 'sent', provider = $2, provider_message_id = $3, sent_at = now(), last_error = NULL,
         attachments = NULL WHERE id = $1`,
      [msg.id, provider.name, out.providerMessageId],
    );
    await emitEvent(account.id, 'email.sent', { message_id: msg.id, to: msg.to_email, from: fromEmail, used_fallback: msg.used_fallback, metadata: msg.metadata });
  } catch (err: any) {
    const temporary = err instanceof ProviderError ? err.temporary : true;
    const wait = RETRY_SECONDS[msg.attempts - 1];
    if (temporary && wait !== undefined) {
      await query(`UPDATE messages SET status = 'queued', next_attempt_at = now() + make_interval(secs => $2), last_error = $3 WHERE id = $1`, [
        msg.id,
        wait,
        String(err.message).slice(0, 500),
      ]);
    } else {
      await fail(String(err.message).slice(0, 500));
    }
  }
}
