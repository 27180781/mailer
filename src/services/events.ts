import { one, query } from '../db.js';
import type { ProviderEvent } from '../providers/index.js';
import { suppress, unsubscribeContact } from './suppression.js';
import { emitEvent } from './webhooks.js';

const SOFT_BOUNCE_LIMIT = 3;

async function logEvent(msg: any, type: string, data: Record<string, unknown>) {
  await query('INSERT INTO events (account_id, message_id, type, data) VALUES ($1, $2, $3, $4)', [msg.account_id, msg.id, type, JSON.stringify(data)]);
}

/** Updates the per-recipient row of a CC/BCC message. Returns its kind (to/cc/bcc), or null for single-recipient messages. */
async function updateRecipient(msg: any, email: string, status: string, detail?: string) {
  const row = await one<{ kind: string }>(
    `UPDATE message_recipients SET status = $3, detail = $4, updated_at = now() WHERE message_id = $1 AND email = $2 RETURNING kind`,
    [msg.id, email.toLowerCase(), status, detail ?? null],
  );
  return row?.kind ?? null;
}

/** The message's own status follows its primary recipient (the first To). */
const isPrimary = (msg: any, email: string) => email.toLowerCase() === String(msg.to_email).toLowerCase();

/** Applies normalized provider events (delivery, bounce, complaint) to messages, contacts and suppressions. */
export async function handleProviderEvents(events: ProviderEvent[], opts: { simulated?: boolean } = {}) {
  for (const ev of events) {
    const msg = await one('SELECT * FROM messages WHERE provider_message_id = $1', [ev.providerMessageId]);
    if (!msg) continue;
    const recipientStatus = { delivered: 'delivered', bounced: 'bounced', complained: 'complained', rejected: 'failed', delayed: 'delayed' }[ev.type];
    const kind = await updateRecipient(msg, ev.recipient, recipientStatus, ev.detail);
    const primary = isPrimary(msg, ev.recipient);
    const base = { message_id: msg.id, to: msg.to_email, recipient: ev.recipient, recipient_type: kind ?? 'to', metadata: msg.metadata, campaign_id: msg.campaign_id, test: msg.test };
    await logEvent(msg, ev.type, { recipient: ev.recipient, bounce_type: ev.bounceType, detail: ev.detail });
    // Simulated events (test keys) never touch suppressions or contacts: they would block real addresses.
    const real = !opts.simulated && !msg.test;

    switch (ev.type) {
      case 'delivered':
        if (primary) await query(`UPDATE messages SET status = 'delivered' WHERE id = $1 AND status = 'sent'`, [msg.id]);
        await emitEvent(msg.account_id, 'email.delivered', base);
        break;
      case 'bounced':
        if (primary) await query(`UPDATE messages SET status = 'bounced', last_error = $2 WHERE id = $1`, [msg.id, ev.detail ?? null]);
        if (real && ev.bounceType === 'hard') {
          await suppress(null, ev.recipient, 'bounce');
          await query(`UPDATE contacts SET status = 'bounced', updated_at = now() WHERE email = $1`, [ev.recipient.toLowerCase()]);
        } else if (real) {
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
        if (primary) await query(`UPDATE messages SET status = 'complained' WHERE id = $1`, [msg.id]);
        if (real) {
          await unsubscribeContact(msg.account_id, ev.recipient);
          await suppress(msg.account_id, ev.recipient, 'complaint');
          await query(`UPDATE contacts SET status = 'complained', updated_at = now() WHERE account_id = $1 AND email = $2`, [msg.account_id, ev.recipient.toLowerCase()]);
        }
        await emitEvent(msg.account_id, 'email.complained', base);
        break;
      case 'rejected':
        if (primary) await query(`UPDATE messages SET status = 'failed', last_error = $2 WHERE id = $1`, [msg.id, `rejected: ${ev.detail ?? ''}`]);
        await emitEvent(msg.account_id, 'email.failed', { ...base, error: ev.detail });
        break;
      case 'delayed':
        await emitEvent(msg.account_id, 'email.delayed', { ...base, detail: ev.detail });
        break;
    }
  }
}

/**
 * Test keys: simulates what the provider would report, by the recipient's local part:
 * bounce… → hard bounce, complaint… → complaint, delay… → delayed then delivered, anything else → delivered.
 */
export async function simulateTestEvents(msg: any, recipients: string[]) {
  const id = `test-${msg.id}`;
  const events: ProviderEvent[] = [];
  for (const r of recipients) {
    const local = r.split('@')[0];
    const at = new Date();
    if (local.startsWith('bounce')) events.push({ type: 'bounced', providerMessageId: id, recipient: r, bounceType: 'hard', detail: 'smtp; 550 5.1.1 user unknown (test)', occurredAt: at });
    else if (local.startsWith('complaint')) {
      events.push({ type: 'delivered', providerMessageId: id, recipient: r, occurredAt: at });
      events.push({ type: 'complained', providerMessageId: id, recipient: r, detail: 'abuse (test)', occurredAt: at });
    } else if (local.startsWith('delay')) {
      events.push({ type: 'delayed', providerMessageId: id, recipient: r, detail: 'MailboxFull (test)', occurredAt: at });
      events.push({ type: 'delivered', providerMessageId: id, recipient: r, occurredAt: at });
    } else events.push({ type: 'delivered', providerMessageId: id, recipient: r, occurredAt: at });
  }
  await handleProviderEvents(events, { simulated: true });
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
