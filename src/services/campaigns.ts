import { one, query } from '../db.js';
import { sentToday } from './send.js';
import { emitEvent } from './webhooks.js';

const MIN_FOR_RATES = 500;
const MAX_BOUNCE_RATE = 0.05;
const MAX_COMPLAINT_RATE = 0.003;

export async function campaignStats(campaignId: string) {
  const row = await one(
    `SELECT count(*)::int AS total,
       count(*) FILTER (WHERE status = 'queued' OR status = 'sending')::int AS queued,
       count(*) FILTER (WHERE status IN ('sent','delivered','bounced','complained'))::int AS sent,
       count(*) FILTER (WHERE status = 'delivered')::int AS delivered,
       count(*) FILTER (WHERE status = 'bounced')::int AS bounced,
       count(*) FILTER (WHERE status = 'complained')::int AS complained,
       count(*) FILTER (WHERE status = 'failed')::int AS failed,
       count(*) FILTER (WHERE status = 'suppressed')::int AS suppressed,
       count(opened_at)::int AS opened,
       count(clicked_at)::int AS clicked
     FROM messages WHERE campaign_id = $1`,
    [campaignId],
  );
  const unsub = await one<{ n: number }>(`SELECT count(*)::int AS n FROM events e JOIN messages m ON m.id = e.message_id WHERE m.campaign_id = $1 AND e.type = 'unsubscribed'`, [campaignId]);
  return { ...row, unsubscribed: unsub?.n ?? 0 };
}

async function pause(campaign: any, reason: string) {
  await query(`UPDATE campaigns SET status = 'paused', paused_reason = $2, updated_at = now() WHERE id = $1`, [campaign.id, reason]);
  await emitEvent(campaign.account_id, 'campaign.paused', { campaign_id: campaign.id, reason });
}

/** Turns due scheduled campaigns into queued messages, one per unique, non-suppressed recipient. */
export async function startDueCampaigns() {
  const due = await query(`SELECT c.*, a.daily_limit, a.status AS account_status FROM campaigns c JOIN accounts a ON a.id = c.account_id
                           WHERE c.status = 'scheduled' AND c.scheduled_at <= now() LIMIT 5`);
  for (const c of due) {
    if (c.account_status !== 'active') {
      await pause(c, 'החשבון עדיין לא אושר לשליחת דיוורים');
      continue;
    }
    const recipients = await one<{ n: number }>(
      `SELECT count(DISTINCT ct.id)::int AS n FROM campaign_lists cl
       JOIN list_members lm ON lm.list_id = cl.list_id AND lm.status = 'confirmed'
       JOIN contacts ct ON ct.id = lm.contact_id AND ct.status = 'active'
       WHERE cl.campaign_id = $1`,
      [c.id],
    );
    const used = await sentToday(c.account_id);
    if ((recipients?.n ?? 0) + used > c.daily_limit) {
      await pause(c, `מספר הנמענים (${recipients?.n}) חורג מהמכסה היומית שנותרה (${c.daily_limit - used})`);
      continue;
    }
    await query(
      `INSERT INTO messages (account_id, sender_id, campaign_id, contact_id, kind, priority, to_email, from_email, from_name, reply_to, subject)
       SELECT DISTINCT ON (ct.id) c.account_id, c.sender_id, c.id, ct.id, 'campaign', 10, ct.email, c.from_email, c.from_name, c.reply_to, c.subject
       FROM campaigns c
       JOIN campaign_lists cl ON cl.campaign_id = c.id
       JOIN list_members lm ON lm.list_id = cl.list_id AND lm.status = 'confirmed'
       JOIN contacts ct ON ct.id = lm.contact_id AND ct.status = 'active'
       WHERE c.id = $1
         AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.email = ct.email AND (s.account_id IS NULL OR s.account_id = c.account_id))`,
      [c.id],
    );
    await query(`UPDATE campaigns SET status = 'sending', started_at = now(), updated_at = now() WHERE id = $1`, [c.id]);
  }
}

/** Pauses campaigns with bad bounce/complaint rates and closes finished ones. */
export async function superviseCampaigns() {
  const sending = await query(`SELECT * FROM campaigns WHERE status = 'sending'`);
  for (const c of sending) {
    const s = await campaignStats(c.id);
    if (s.sent >= MIN_FOR_RATES) {
      if (s.bounced / s.sent > MAX_BOUNCE_RATE) {
        await pause(c, `שיעור חזרות גבוה (${((s.bounced / s.sent) * 100).toFixed(1)}%). כדאי לנקות את הרשימה`);
        continue;
      }
      if (s.complained / s.sent > MAX_COMPLAINT_RATE) {
        await pause(c, `שיעור תלונות ספאם גבוה (${((s.complained / s.sent) * 100).toFixed(2)}%)`);
        continue;
      }
    }
    if (s.queued === 0) {
      await query(`UPDATE campaigns SET status = 'sent', finished_at = now(), updated_at = now() WHERE id = $1`, [c.id]);
      await emitEvent(c.account_id, 'campaign.finished', { campaign_id: c.id, stats: s });
    }
  }
}
