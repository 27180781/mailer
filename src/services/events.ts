import { one, query } from '../db.js';
import type { ProviderEvent } from '../providers/index.js';
import { suppress, unsubscribeContact } from './suppression.js';
import { emitEvent } from './webhooks.js';

const SOFT_BOUNCE_LIMIT = 3;

async function logEvent(msg: any, type: string, data: Record<string, unknown>) {
  await query('INSERT INTO events (account_id, message_id, type, data) VALUES ($1, $2, $3, $4)', [msg.account_id, msg.id, type, JSON.stringify(data)]);
}

/** Applies normalized provider events (delivery, bounce, complaint) to messages, contacts and suppressions. */
export async function handleProviderEvents(events: ProviderEvent[]) {
  for (const ev of events) {
    const msg = await one('SELECT * FROM messages WHERE provider_message_id = $1', [ev.providerMessageId]);
    if (!msg) continue;
    const base = { message_id: msg.id, to: msg.to_email, metadata: msg.metadata, campaign_id: msg.campaign_id };
    await logEvent(msg, ev.type, { recipient: ev.recipient, bounce_type: ev.bounceType, detail: ev.detail });

    switch (ev.type) {
      case 'delivered':
        await query(`UPDATE messages SET status = 'delivered' WHERE id = $1 AND status = 'sent'`, [msg.id]);
        await emitEvent(msg.account_id, 'email.delivered', base);
        break;
      case 'bounced':
        await query(`UPDATE messages SET status = 'bounced', last_error = $2 WHERE id = $1`, [msg.id, ev.detail ?? null]);
        if (ev.bounceType === 'hard') {
          await suppress(null, ev.recipient, 'bounce');
          await query(`UPDATE contacts SET status = 'bounced', updated_at = now() WHERE email = $1`, [ev.recipient.toLowerCase()]);
        } else {
          await query('INSERT INTO soft_bounces (email, account_id) VALUES ($1, $2)', [ev.recipient.toLowerCase(), msg.account_id]);
          const row = await one<{ n: string }>(
            `SELECT count(*) AS n FROM soft_bounces WHERE account_id = $1 AND email = $2 AND created_at > now() - interval '30 days'`,
            [msg.account_id, ev.recipient.toLowerCase()],
          );
          if (Number(row?.n) >= SOFT_BOUNCE_LIMIT) await suppress(msg.account_id, ev.recipient, 'bounce');
        }
        await emitEvent(msg.account_id, 'email.bounced', { ...base, bounce_type: ev.bounceType, detail: ev.detail });
        break;
      case 'complained':
        await query(`UPDATE messages SET status = 'complained' WHERE id = $1`, [msg.id]);
        await unsubscribeContact(msg.account_id, ev.recipient);
        await suppress(msg.account_id, ev.recipient, 'complaint');
        await query(`UPDATE contacts SET status = 'complained', updated_at = now() WHERE account_id = $1 AND email = $2`, [msg.account_id, ev.recipient.toLowerCase()]);
        await emitEvent(msg.account_id, 'email.complained', base);
        break;
      case 'rejected':
        await query(`UPDATE messages SET status = 'failed', last_error = $2 WHERE id = $1`, [msg.id, `rejected: ${ev.detail ?? ''}`]);
        await emitEvent(msg.account_id, 'email.failed', { ...base, error: ev.detail });
        break;
      case 'delayed':
        break;
    }
  }
}

/** Records an open or click from our own tracking endpoints. */
export async function recordEngagement(messageId: string, type: 'opened' | 'clicked', data: Record<string, unknown> = {}) {
  const col = type === 'opened' ? 'opened_at' : 'clicked_at';
  const msg = await one(
    `UPDATE messages SET ${col} = coalesce(${col}, now()) ${type === 'clicked' ? ', opened_at = coalesce(opened_at, now())' : ''}
     WHERE id = $1 RETURNING id, account_id, to_email, metadata, campaign_id, (xmax = 0) AS fresh`,
    [messageId],
  );
  if (!msg) return;
  await logEvent(msg, type, data);
  await emitEvent(msg.account_id, `email.${type}`, { message_id: msg.id, to: msg.to_email, metadata: msg.metadata, campaign_id: msg.campaign_id, ...data });
}
