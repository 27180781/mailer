import { config } from '../config.js';
import { one, query } from '../db.js';
import { decryptSecret, signToken } from '../crypto.js';
import { INFORU_BATCH, InforuError, inforuCampaignStats, inforuMailNotifications, inforuSend, inforuUnsubscribes, type InforuCredentials } from '../providers/inforu.js';
import { recordEngagement } from './events.js';
import { advertisingSubject, escapeHtml, personalize } from './render.js';
import { suppress, suppressionReason, unsubscribeContact } from './suppression.js';
import { emitEvent } from './webhooks.js';

/** The account's InforU login, or null when it has not connected InforU */
export function inforuCredentials(account: any): InforuCredentials | null {
  if (!account?.inforu_username || !account?.inforu_token_enc) return null;
  return { username: account.inforu_username, token: decryptSecret(account.inforu_token_enc) };
}

/** One unsubscribe page per campaign (InforU sends a single body to many people, so the link can't be personal) */
export const campaignUnsubscribeUrl = (campaignId: string) => `${config.publicUrl}/u/c/${signToken(campaignId)}`;

/** Renders the campaign for one contact. Identical results are grouped into one InforU call. */
function render(campaign: any, account: any, contact: any, email: string) {
  const vars = { name: contact?.name ?? '', email, attr: contact?.attributes ?? {} };
  let subject = personalize(campaign.subject, vars, false);
  if (campaign.is_advertisement) subject = advertisingSubject(subject);
  let html = personalize(campaign.html || `<div dir="rtl">${escapeHtml(campaign.text ?? '')}</div>`, vars, true);
  // No footer from us: InforU appends its own (sender details, unsubscribe, spam report)
  return { subject, html };
}

async function pause(campaign: any, reason: string) {
  await query(`UPDATE campaigns SET status = 'paused', paused_reason = $2, updated_at = now() WHERE id = $1 AND status = 'sending'`, [campaign.id, reason]);
  await emitEvent(campaign.account_id, 'campaign.paused', { campaign_id: campaign.id, reason });
}

const MAX_ATTEMPTS = 5;

/**
 * Hands queued messages of InforU campaigns to InforU in batches. Called by the worker every few seconds.
 * The messages are created exactly like SES campaigns (dedupe, suppressions), so the recipients list and the
 * unsubscribe and suppression rules stay the same; only the last step goes to InforU instead of SES.
 */
export async function processInforuCampaigns(limitPerCampaign = 5000) {
  const campaigns = await query(`SELECT * FROM campaigns WHERE status = 'sending' AND channel = 'inforu' ORDER BY started_at LIMIT 5`);
  let handed = 0;
  for (const campaign of campaigns) {
    const account = await one('SELECT * FROM accounts WHERE id = $1', [campaign.account_id]);
    let creds: InforuCredentials | null = null;
    try { creds = inforuCredentials(account); } catch {}
    if (!creds) {
      await pause(campaign, 'החיבור ל-InforU הוסר או לא תקין. מחברים מחדש בהגדרות החשבון וממשיכים את הדיוור');
      continue;
    }
    // Groups that live in InforU: one call, sent once. The body can't be personal (InforU fills it for everyone).
    const groups = (campaign.inforu_groups ?? []) as { id: number; name: string; recipients: number }[];
    if (groups.length && !campaign.inforu_groups_sent_at) {
      const claimedGroups = await one(`UPDATE campaigns SET inforu_groups_sent_at = now() WHERE id = $1 AND inforu_groups_sent_at IS NULL RETURNING id`, [campaign.id]);
      if (claimedGroups) {
        const r = render(campaign, account, null, '');
        try {
          const { campaignId: iuId } = await inforuSend(creds, {
            campaignName: campaign.name,
            campaignRefId: `${campaign.id}:groups`,
            fromAddress: campaign.from_email,
            fromName: campaign.from_name,
            replyAddress: campaign.reply_to,
            subject: r.subject,
            html: r.html,
            contacts: [],
            groupIds: groups.map((g) => g.id),
            allowDuplicates: false,
          });
          await query(
            `UPDATE campaigns SET inforu_groups_request_id = $2::text, inforu_campaign_ids = CASE WHEN $3::bigint IS NULL THEN inforu_campaign_ids ELSE array_append(inforu_campaign_ids, $3::bigint) END WHERE id = $1`,
            [campaign.id, iuId ? String(iuId) : null, iuId ? String(iuId) : null],
          );
          handed += groups.reduce((n, g) => n + (g.recipients || 0), 0);
        } catch (err: any) {
          await query('UPDATE campaigns SET inforu_groups_sent_at = NULL WHERE id = $1', [campaign.id]);
          const message = String(err?.message ?? err).slice(0, 500);
          await pause(campaign, `השליחה לקבוצות InforU נעצרה: ${message}`);
          continue;
        }
      }
    }
    // Claim a slice of this campaign's queue (other workers skip these rows)
    const claimed = await query(
      `UPDATE messages SET status = 'sending', attempts = attempts + 1, next_attempt_at = now()
       WHERE id IN (SELECT id FROM messages WHERE campaign_id = $1 AND status = 'queued' AND next_attempt_at <= now()
                    ORDER BY created_at LIMIT $2 FOR UPDATE SKIP LOCKED)
       RETURNING *`,
      [campaign.id, limitPerCampaign],
    );
    if (!claimed.length) continue;

    const contacts = new Map<string, any>(
      (await query('SELECT * FROM contacts WHERE id = ANY($1)', [claimed.map((m: any) => m.contact_id).filter(Boolean)])).map((c: any) => [c.id, c]),
    );
    const bodies = new Map<string, { subject: string; html: string; messages: any[] }>();
    for (const m of claimed) {
      const why = await suppressionReason(account.id, m.to_email, 'campaign');
      if (why) {
        await query(`UPDATE messages SET status = 'suppressed', last_error = $2 WHERE id = $1`, [m.id, `suppressed:${why}`]);
        continue;
      }
      const r = render(campaign, account, contacts.get(m.contact_id), m.to_email);
      const key = `${r.subject}\u0000${r.html}`;
      if (!bodies.has(key)) bodies.set(key, { ...r, messages: [] });
      bodies.get(key)!.messages.push(m);
    }

    let part = 0;
    let stopped = false;
    for (const g of bodies.values()) {
      if (stopped) break;
      for (let i = 0; i < g.messages.length; i += INFORU_BATCH) {
        const batch = g.messages.slice(i, i + INFORU_BATCH);
        const ids = batch.map((m: any) => m.id);
        part++;
        try {
          const { campaignId: iuId, requestId } = await inforuSend(creds, {
            campaignName: campaign.name,
            campaignRefId: `${campaign.id}:${ids[0]}`,
            fromAddress: campaign.from_email,
            fromName: campaign.from_name,
            replyAddress: campaign.reply_to,
            subject: g.subject,
            html: g.html,
            contacts: batch.map((m: any) => ({ email: m.to_email, firstName: contacts.get(m.contact_id)?.name ?? null })),
            allowDuplicates: false,
          });
          await query(
            `UPDATE messages SET status = 'sent', provider = 'inforu', provider_message_id = $2, sent_at = now(), last_error = NULL WHERE id = ANY($1)`,
            [ids, iuId ? `inforu:${iuId}` : requestId || null],
          );
          if (iuId) await query(`UPDATE campaigns SET inforu_campaign_ids = array_append(inforu_campaign_ids, $2::bigint) WHERE id = $1`, [campaign.id, String(iuId)]);
          handed += batch.length;
          for (const m of batch)
            await emitEvent(campaign.account_id, 'email.sent', { message_id: m.id, to: m.to_email, campaign_id: campaign.id, provider: 'inforu' });
        } catch (err: any) {
          const message = String(err?.message ?? err).slice(0, 500);
          const fatal = err instanceof InforuError && err.fatal;
          const giveUp = fatal || batch.some((m: any) => m.attempts >= MAX_ATTEMPTS);
          // Back to the queue either way; a paused campaign simply waits for "resume"
          await query(
            `UPDATE messages SET status = 'queued', last_error = $2, next_attempt_at = now() + interval '5 minutes' WHERE id = ANY($1) AND status = 'sending'`,
            [ids, message],
          );
          if (giveUp) {
            await query(`UPDATE messages SET status = 'queued', next_attempt_at = now() WHERE campaign_id = $1 AND status = 'sending'`, [campaign.id]);
            await pause(campaign, `השליחה דרך InforU נעצרה: ${message}`);
            stopped = true;
            break;
          }
          console.error(`inforu campaign ${campaign.id} part ${part} failed, will retry`, message);
        }
      }
    }
    // Anything left claimed (e.g. after a pause) goes back to the queue
    await query(`UPDATE messages SET status = 'queued' WHERE campaign_id = $1 AND status = 'sending' AND provider_message_id IS NULL`, [campaign.id]);
  }
  return handed;
}

/** A test send of an InforU campaign, through InforU, to a few addresses */
export async function inforuTestSend(campaign: any, account: any, to: string[]) {
  const creds = inforuCredentials(account);
  if (!creds) throw new Error('InforU לא מחובר לחשבון');
  const r = render(campaign, account, null, to[0]);
  return inforuSend(creds, {
    campaignName: `[בדיקה] ${campaign.name}`,
    campaignRefId: `${campaign.id}:test:${Date.now()}`,
    fromAddress: campaign.from_email,
    fromName: campaign.from_name,
    replyAddress: campaign.reply_to,
    subject: `[בדיקה] ${r.subject}`,
    html: r.html,
    contacts: to.map((email) => ({ email })),
    allowDuplicates: true,
  });
}

// ---------- Reports back from InforU ----------

/** Totals of a campaign: the sum over the InforU campaigns it was sent as (batches and group calls) */
export async function syncInforuCampaignStats(campaign: any, account: any) {
  const creds = inforuCredentials(account);
  const ids: number[] = (campaign.inforu_campaign_ids ?? []).map(Number);
  if (!creds || !ids.length) return null;
  const rows = await inforuCampaignStats(creds, ids);
  const sum = rows.reduce(
    (t, r) => ({ sent: t.sent + r.sent, opened: t.opened + r.opened, clicks: t.clicks + r.clicks, returned: t.returned + r.returned, blocked: t.blocked + r.blocked }),
    { sent: 0, opened: 0, clicks: 0, returned: 0, blocked: 0 },
  );
  const stats = { ...sum, campaigns: rows.length, statuses: [...new Set(rows.map((r) => r.status))] };
  await query('UPDATE campaigns SET inforu_stats = $2, inforu_stats_at = now() WHERE id = $1', [campaign.id, JSON.stringify(stats)]);
  return stats;
}

/**
 * Pulls per-recipient events and applies them to our messages (when InforU has the notification queue enabled
 * for the account). Events of group sends or of campaigns sent elsewhere have no message here and are skipped.
 */
export async function applyInforuNotifications(account: any, maxBatches = 10) {
  const creds = inforuCredentials(account);
  if (!creds) return 0;
  let applied = 0;
  for (let b = 0; b < maxBatches; b++) {
    const events = await inforuMailNotifications(creds, 500);
    if (!events.length) break;
    for (const ev of events) {
      const email = String(ev.Email ?? '').toLowerCase();
      const msg = await one(
        `SELECT * FROM messages WHERE account_id = $1 AND provider = 'inforu' AND provider_message_id = $2 AND to_email = $3 LIMIT 1`,
        [account.id, `inforu:${ev.CampaignId}`, email],
      );
      if (!msg) continue;
      const action = String(ev.Action ?? '').toLowerCase();
      const data = { via: 'inforu', value: ev.Value ?? null, info: ev.MoreInfo ?? null, at: ev.Datetime };
      if (action === 'open') await recordEngagement(msg.id, 'opened', data);
      else if (action === 'click') await recordEngagement(msg.id, 'clicked', { ...data, url: ev.Value ?? null });
      else if (action === 'dsn' || action === 'return') {
        const code = String(ev.Value ?? '');
        const hard = action === 'return' || code.startsWith('5');
        if (code.startsWith('2') && !hard) {
          await query(`UPDATE messages SET status = 'delivered' WHERE id = $1 AND status = 'sent'`, [msg.id]);
          await query('INSERT INTO events (account_id, message_id, type, data) VALUES ($1, $2, $3, $4)', [account.id, msg.id, 'delivered', JSON.stringify(data)]);
        } else if (hard) {
          await query(`UPDATE messages SET status = 'bounced', last_error = $2 WHERE id = $1 AND status IN ('sent','delivered')`, [msg.id, String(ev.AdditionalInformation ?? code).slice(0, 500)]);
          await query('INSERT INTO events (account_id, message_id, type, data) VALUES ($1, $2, $3, $4)', [account.id, msg.id, 'bounced', JSON.stringify(data)]);
          await suppress(account.id, email, 'bounce');
          await query(`UPDATE contacts SET status = 'bounced', updated_at = now() WHERE account_id = $1 AND email = $2 AND status = 'active'`, [account.id, email]);
        } else continue; // 4.x.x: deferred, InforU keeps trying
      } else if (action === 'unsubscribe') {
        await unsubscribeContact(account.id, email);
        await query('INSERT INTO events (account_id, message_id, type, data) VALUES ($1, $2, $3, $4)', [account.id, msg.id, 'unsubscribed', JSON.stringify(data)]);
      } else continue;
      applied++;
    }
    if (events.length < 500) break;
  }
  return applied;
}

const ymd = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, '/');

/** People who unsubscribed through InforU's link stop getting this account's marketing from here too */
export async function syncInforuUnsubscribes(account: any) {
  const creds = inforuCredentials(account);
  if (!creds) return 0;
  const from = account.inforu_unsub_synced_at ? new Date(new Date(account.inforu_unsub_synced_at).getTime() - 86_400_000) : new Date(Date.now() - 90 * 86_400_000);
  let last: number | null = account.inforu_unsub_last_id ?? null;
  let n = 0;
  for (let i = 0; i < 20; i++) {
    const r = await inforuUnsubscribes(creds, ymd(from), ymd(new Date()), last);
    for (const u of r.list) {
      const email = String(u.Value ?? '').trim().toLowerCase();
      if (!email.includes('@')) continue;
      await unsubscribeContact(account.id, email);
      n++;
    }
    if (!r.list.length || r.lastFetchedId === last) break;
    last = r.lastFetchedId;
  }
  await query('UPDATE accounts SET inforu_unsub_last_id = $2, inforu_unsub_synced_at = now() WHERE id = $1', [account.id, last]);
  return n;
}

/** Worker job: refresh totals of recent InforU campaigns, apply events, sync unsubscribes */
export async function syncInforuReports() {
  const accounts = await query(`SELECT * FROM accounts WHERE inforu_username IS NOT NULL AND inforu_token_enc IS NOT NULL`);
  for (const account of accounts) {
    try {
      await applyInforuNotifications(account);
      const campaigns = await query(
        `SELECT * FROM campaigns WHERE account_id = $1 AND channel = 'inforu' AND cardinality(inforu_campaign_ids) > 0
           AND started_at > now() - interval '30 days' AND (inforu_stats_at IS NULL OR inforu_stats_at < now() - interval '10 minutes')
         ORDER BY inforu_stats_at NULLS FIRST LIMIT 20`,
        [account.id],
      );
      for (const c of campaigns) await syncInforuCampaignStats(c, account);
      if (!account.inforu_unsub_synced_at || Date.now() - new Date(account.inforu_unsub_synced_at).getTime() > 3_600_000) await syncInforuUnsubscribes(account);
    } catch (err) {
      console.error(`inforu report sync failed for account ${account.id}`, String((err as any)?.message ?? err));
    }
  }
}
