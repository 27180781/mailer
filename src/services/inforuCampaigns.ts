import { config } from '../config.js';
import { one, query } from '../db.js';
import { decryptSecret, signToken } from '../crypto.js';
import { INFORU_BATCH, InforuError, inforuSend, type InforuCredentials } from '../providers/inforu.js';
import { advertisingSubject, escapeHtml, insertFooter, personalize } from './render.js';
import { suppressionReason } from './suppression.js';
import { emitEvent } from './webhooks.js';

/** The account's InforU login, or null when it has not connected InforU */
export function inforuCredentials(account: any): InforuCredentials | null {
  if (!account?.inforu_username || !account?.inforu_token_enc) return null;
  return { username: account.inforu_username, token: decryptSecret(account.inforu_token_enc) };
}

/** One unsubscribe page per campaign (InforU sends a single body to many people, so the link can't be personal) */
export const campaignUnsubscribeUrl = (campaignId: string) => `${config.publicUrl}/u/c/${signToken(campaignId)}`;

/** Legal footer for InforU campaigns: company details and our campaign unsubscribe page; InforU adds its own link too */
function inforuFooter(account: any, campaignId: string) {
  const parts = [account.company_name, account.company_address, account.contact_email].filter(Boolean).map((s: string) => escapeHtml(String(s)));
  return `<div dir="rtl" style="margin-top:32px;padding-top:16px;border-top:1px solid #ddd;font-family:Arial,sans-serif;font-size:12px;color:#666;text-align:center;line-height:1.6">
${parts.length ? `<div>${parts.join(' · ')}</div>` : ''}
<div>קיבלת את המייל הזה כי נרשמת לקבלת עדכונים. <a href="${campaignUnsubscribeUrl(campaignId)}" style="color:#666">להסרה מרשימת התפוצה לחצו כאן</a></div>
</div>`;
}

/** Renders the campaign for one contact. Identical results are grouped into one InforU call. */
function render(campaign: any, account: any, contact: any, email: string) {
  const vars = { name: contact?.name ?? '', email, attr: contact?.attributes ?? {} };
  let subject = personalize(campaign.subject, vars, false);
  if (campaign.is_advertisement) subject = advertisingSubject(subject);
  let html = personalize(campaign.html || `<div dir="rtl">${escapeHtml(campaign.text ?? '')}</div>`, vars, true);
  html = insertFooter(html, inforuFooter(account, campaign.id));
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
          const { requestId } = await inforuSend(creds, {
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
          await query('UPDATE campaigns SET inforu_groups_request_id = $2 WHERE id = $1', [campaign.id, requestId || null]);
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
          const { requestId } = await inforuSend(creds, {
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
            [ids, requestId || null],
          );
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
