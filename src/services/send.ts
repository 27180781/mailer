import { randomUUID } from 'node:crypto';
import { one, query } from '../db.js';
import { ApiError } from '../errors.js';
import { getProvider, ProviderError } from '../providers/index.js';
import { domainOf, domainOwnedElsewhere, findSendingDomain, FREEMAIL_DOMAINS } from './domains.js';
import { suppressionReason } from './suppression.js';
import { emitEvent } from './webhooks.js';
import { simulateTestEvents } from './events.js';
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
    `SELECT count(*) AS n FROM messages WHERE account_id = $1 AND NOT test AND created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Jerusalem') AT TIME ZONE 'Asia/Jerusalem'`,
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
  cc?: string[];
  bcc?: string[];
  subject: string;
  html?: string | null;
  text?: string | null;
  type?: 'transactional' | 'marketing';
  attachments?: Attachment[];
  headers?: Record<string, string>;
  metadata?: Record<string, unknown>;
  idempotency_key?: string | null;
  scheduled_at?: string | null;
  /** Test API key: everything runs except the actual sending */
  test?: boolean;
}

const MAX_RECIPIENTS = 50; // SES limit per message

/** Splits custom headers into the Message-ID (stored apart) and the rest. Header names are normalized. */
export function splitHeaders(headers: Record<string, string> = {}) {
  let messageId: string | null = null;
  const rest: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    if (lk === 'message-id') messageId = v.trim();
    else if (lk === 'in-reply-to') rest['In-Reply-To'] = v.trim();
    else if (lk === 'references') rest['References'] = v.trim();
    else rest[k] = v;
  }
  if (messageId && !/^<[^<>@\s]+@[^<>@\s]+>$/.test(messageId)) {
    throw new ApiError(400, 'invalid_message_id', 'Message-ID צריך להיות בפורמט <מזהה@דומיין>');
  }
  return { messageId, headers: rest };
}

/**
 * Validates and queues a direct (API) email.
 * Without CC/BCC every "to" address gets its own message. With CC or BCC it is one message to everyone.
 */
export async function enqueueEmail(account: any, input: SendInput) {
  const senderId = input.sender_id ?? null;
  if (senderId) {
    const sender = await one('SELECT * FROM senders WHERE id = $1 AND account_id = $2', [senderId, account.id]);
    if (!sender) throw new ApiError(404, 'sender_not_found', 'השולח לא נמצא');
    if (sender.status !== 'active') throw new ApiError(403, 'sender_suspended', 'השולח מושעה');
    input.reply_to ??= sender.default_reply_to;
  }

  const cols = 'id, to_email, to_list, cc, bcc, status, used_fallback, from_email, message_id_header, test';
  if (input.idempotency_key) {
    const existing = await query(
      `SELECT ${cols} FROM messages WHERE account_id = $1 AND (idempotency_key = $2 OR idempotency_key LIKE $2 || ':%')`,
      [account.id, input.idempotency_key],
    );
    if (existing.length) return { duplicate: true, messages: existing, warnings: [] as string[] };
  }

  const norm = (list?: string[]) => [...new Set((list ?? []).map((e) => e.trim().toLowerCase()))];
  const to = norm(input.to), cc = norm(input.cc).filter((e) => !to.includes(e)), bcc = norm(input.bcc).filter((e) => !to.includes(e) && !cc.includes(e));
  const grouped = cc.length > 0 || bcc.length > 0;
  if (to.length + cc.length + bcc.length > MAX_RECIPIENTS) throw new ApiError(400, 'too_many_recipients', `עד ${MAX_RECIPIENTS} נמענים במייל (to, cc ו-bcc יחד)`);

  const { messageId: customMessageId, headers } = splitHeaders(input.headers);
  if (customMessageId && !grouped && to.length > 1) {
    throw new ApiError(400, 'message_id_needs_single_message', 'Message-ID מותאם אפשרי רק כשנשלח מייל אחד: נמען אחד ב-to, או שימוש ב-cc/bcc');
  }

  const test = !!input.test;
  if (!test) await assertQuota(account, to.length + cc.length + bcc.length);
  const warnings: string[] = [];
  let resolved: ResolvedFrom;
  try {
    resolved = await resolveFrom(account, senderId, input.from, input.fallback ?? 'reject');
  } catch (err: any) {
    // Test keys may send from a domain that isn't verified yet, so integration can start before DNS is ready.
    if (!test || !['domain_not_verified', 'no_fallback', 'fallback_not_verified'].includes(err.code)) throw err;
    resolved = { fromEmail: input.from.email.trim().toLowerCase(), fromName: input.from.name?.trim() || null, usedFallback: false, domain: null };
    warnings.push('domain_not_verified');
  }
  const kind = input.type ?? 'transactional';
  const fromDomain = resolved.domain?.name ?? domainOf(resolved.fromEmail);
  const meta = JSON.stringify({ ...(input.metadata ?? {}), fallback: input.fallback ?? 'reject' });

  const insert = async (id: string, primary: string, key: string | null, status: string, lastError: string | null, lists: { to: string[]; cc: string[]; bcc: string[] }) =>
    one(
      `INSERT INTO messages (id, account_id, sender_id, kind, priority, to_email, to_list, cc, bcc, from_email, from_name, reply_to, subject, html, text,
         headers, attachments, used_fallback, status, idempotency_key, metadata, next_attempt_at, last_error, message_id_header, test)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21, coalesce($22::timestamptz, now()), $23, $24, $25)
       RETURNING ${cols}`,
      [
        id, account.id, senderId, kind, kind === 'transactional' ? 0 : 5, primary, lists.to, lists.cc, lists.bcc, resolved.fromEmail, resolved.fromName,
        input.reply_to ?? null, input.subject, input.html ?? null, input.text ?? null, JSON.stringify(headers),
        input.attachments?.length ? JSON.stringify(input.attachments) : null, resolved.usedFallback, status, key, meta,
        input.scheduled_at ?? null, lastError, customMessageId ?? `<${id}@${fromDomain}>`, test,
      ],
    );

  const messages: any[] = [];
  if (grouped) {
    const id = randomUUID();
    const all = [...to.map((e) => [e, 'to']), ...cc.map((e) => [e, 'cc']), ...bcc.map((e) => [e, 'bcc'])] as [string, string][];
    const reasons = await Promise.all(all.map(([e]) => suppressionReason(account.id, e, kind)));
    const allSuppressed = reasons.every(Boolean);
    const row = await insert(id, to[0], input.idempotency_key ?? null, allSuppressed ? 'suppressed' : 'queued', allSuppressed ? 'suppressed:all_recipients' : null, { to, cc, bcc });
    for (const [i, [email, k]] of all.entries()) {
      await query(`INSERT INTO message_recipients (message_id, email, kind, status, detail) VALUES ($1,$2,$3,$4,$5)`, [id, email, k, reasons[i] ? 'suppressed' : 'queued', reasons[i] ?? null]);
      if (reasons[i]) await emitEvent(account.id, 'email.suppressed', { message_id: id, recipient: email, recipient_type: k, reason: reasons[i], test });
    }
    messages.push(row);
  } else {
    for (const [i, addr] of to.entries()) {
      const key = input.idempotency_key ? (to.length > 1 ? `${input.idempotency_key}:${i}` : input.idempotency_key) : null;
      const reason = await suppressionReason(account.id, addr, kind);
      const row = await insert(randomUUID(), addr, key, reason ? 'suppressed' : 'queued', reason ? `suppressed:${reason}` : null, { to: [addr], cc: [], bcc: [] });
      if (reason) await emitEvent(account.id, 'email.suppressed', { message_id: row.id, to: addr, recipient: addr, reason, test });
      messages.push(row);
    }
  }
  return { duplicate: false, messages, warnings };
}

const RETRY_SECONDS = [60, 300, 1800];

/** Sends one claimed message. Called by the worker. */
export async function processMessage(msg: any) {
  const account = await one('SELECT * FROM accounts WHERE id = $1', [msg.account_id]);
  const fail = async (error: string, status = 'failed') => {
    await query(`UPDATE messages SET status = $2, last_error = $3 WHERE id = $1`, [msg.id, status, error]);
    await query(`UPDATE message_recipients SET status = $2, detail = $3, updated_at = now() WHERE message_id = $1 AND status = 'queued'`, [msg.id, status, error]);
    await emitEvent(msg.account_id, status === 'suppressed' ? 'email.suppressed' : 'email.failed', { message_id: msg.id, to: msg.to_email, error, metadata: msg.metadata, test: msg.test });
  };
  if (!account || account.status === 'suspended') return fail('account_suspended');

  // Recipients: one, or the list of a CC/BCC message (suppressions re-checked at send time)
  const grouped = (msg.cc?.length ?? 0) + (msg.bcc?.length ?? 0) > 0;
  let recipients: string[];
  if (grouped) {
    const rows = await query<{ email: string }>(`SELECT email FROM message_recipients WHERE message_id = $1 AND status = 'queued'`, [msg.id]);
    recipients = [];
    for (const r of rows) {
      const why = await suppressionReason(account.id, r.email, msg.kind);
      if (why) await query(`UPDATE message_recipients SET status = 'suppressed', detail = $3, updated_at = now() WHERE message_id = $1 AND email = $2`, [msg.id, r.email, why]);
      else recipients.push(r.email);
    }
    if (!recipients.length) return fail('suppressed:all_recipients', 'suppressed');
  } else {
    const reason = await suppressionReason(account.id, msg.to_email, msg.kind);
    if (reason) return fail(`suppressed:${reason}`, 'suppressed');
    recipients = [msg.to_email];
  }

  // The domain may have lost verification since the email was queued.
  let fromEmail = msg.from_email;
  let fromName = msg.from_name;
  let domain = await findSendingDomain(account.id, msg.used_fallback ? null : msg.sender_id, fromEmail);
  if (!domain && !msg.test) {
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
    messageIdHeader: msg.message_id_header,
    domain: domain?.name ?? domainOf(fromEmail),
    fromEmail,
    fromName,
    to: msg.to_list?.length ? msg.to_list : msg.to_email,
    cc: msg.cc ?? [],
    replyTo,
    subject,
    html,
    text,
    headers,
    attachments: msg.attachments,
  });

  if (msg.test) {
    // Test key: nothing leaves the system. Delivery events are simulated from the recipient address.
    await query(`UPDATE messages SET status = 'sent', provider = 'test', provider_message_id = $2, sent_at = now(), last_error = NULL, attachments = NULL WHERE id = $1`, [msg.id, `test-${msg.id}`]);
    await query(`UPDATE message_recipients SET status = 'sent', updated_at = now() WHERE message_id = $1 AND status = 'queued'`, [msg.id]);
    await emitEvent(account.id, 'email.sent', { message_id: msg.id, to: msg.to_email, recipients, from: fromEmail, message_id_header: msg.message_id_header, metadata: msg.metadata, test: true, size: raw.length });
    await simulateTestEvents(msg, recipients);
    return;
  }

  const provider = getProvider(domain.provider);
  try {
    const out = await provider.send({
      id: msg.id,
      from: fromEmail,
      to: msg.to_email,
      recipients,
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
    await query(`UPDATE message_recipients SET status = 'sent', updated_at = now() WHERE message_id = $1 AND status = 'queued'`, [msg.id]);
    await emitEvent(account.id, 'email.sent', { message_id: msg.id, to: msg.to_email, recipients, from: fromEmail, used_fallback: msg.used_fallback, message_id_header: msg.message_id_header, metadata: msg.metadata });
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
