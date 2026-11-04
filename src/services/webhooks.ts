import { query } from '../db.js';
import { hmac, randomToken } from '../crypto.js';

export const WEBHOOK_EVENTS = [
  'email.sent',
  'email.delivered',
  'email.delayed',
  'email.bounced',
  'email.complained',
  'email.failed',
  'email.suppressed',
  'email.opened',
  'email.clicked',
  'email.unsubscribed',
  'domain.verified',
  'domain.failed',
  'domain.degraded',
  'campaign.paused',
  'campaign.finished',
  'account.suspended',
  'contact.created',
  'contact.updated',
  'contact.unsubscribed',
  'contact.deleted',
  'contact.added_to_list',
  'contact.removed_from_list',
] as const;

/** The contact fields sent in contact.* webhooks and returned by the API */
export const contactPayload = (c: any) => ({
  id: c.id,
  email: c.email,
  name: c.name ?? null,
  status: c.status,
  attributes: c.attributes ?? {},
  consent_source: c.consent_source ?? null,
  created_at: c.created_at,
  updated_at: c.updated_at,
});

export function newWebhookSecret() {
  return `whsec_${randomToken(24)}`;
}

/** Queue a webhook event for every active subscription of the account. */
export async function emitEvent(accountId: string, type: string, data: Record<string, unknown>) {
  const payload = { type, created_at: new Date().toISOString(), data };
  await query(
    `INSERT INTO webhook_deliveries (webhook_id, event_type, payload)
     SELECT id, $2, $3 FROM webhooks
     WHERE account_id = $1 AND active AND (cardinality(events) = 0 OR $2 = ANY(events))`,
    [accountId, type, JSON.stringify(payload)],
  );
}

export function signWebhook(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)) {
  return `t=${timestamp},v1=${hmac(`${timestamp}.${body}`, secret)}`;
}

const BACKOFF_SECONDS = [30, 120, 600, 3600, 21600];

/** Deliver due webhook events. Called by the worker. */
export async function deliverWebhooks(limit = 20) {
  const rows = await query(
    `UPDATE webhook_deliveries d SET attempts = attempts + 1, next_attempt_at = now() + interval '5 minutes'
     WHERE d.id IN (SELECT id FROM webhook_deliveries WHERE status = 'pending' AND next_attempt_at <= now()
                    ORDER BY next_attempt_at LIMIT $1 FOR UPDATE SKIP LOCKED)
     RETURNING d.id, d.webhook_id, d.payload, d.attempts`,
    [limit],
  );
  await Promise.all(
    rows.map(async (d) => {
      const [hook] = await query('SELECT url, secret FROM webhooks WHERE id = $1', [d.webhook_id]);
      if (!hook) return;
      const body = JSON.stringify(d.payload);
      try {
        const res = await fetch(hook.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-mailer-signature': signWebhook(hook.secret, body) },
          body,
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await query(`UPDATE webhook_deliveries SET status = 'delivered', last_error = NULL WHERE id = $1`, [d.id]);
      } catch (err: any) {
        const wait = BACKOFF_SECONDS[d.attempts - 1];
        await query(
          `UPDATE webhook_deliveries SET status = $2, last_error = $3, next_attempt_at = now() + make_interval(secs => $4) WHERE id = $1`,
          [d.id, wait === undefined ? 'failed' : 'pending', String(err?.message ?? err).slice(0, 500), wait ?? 0],
        );
      }
    }),
  );
  return rows.length;
}
