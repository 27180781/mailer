import { config } from '../config.js';
import { one } from '../db.js';
import { enqueueEmail } from './send.js';

/**
 * Emails the system sends on its own behalf (team invitations). They go out from SYSTEM_FROM_EMAIL, through the account
 * that owns that verified domain, so they use the same queue, tracking and suppression rules as any email.
 * Returns false when SYSTEM_FROM_EMAIL is not set up; callers then show the link instead.
 */
export async function sendSystemEmail(to: string, subject: string, html: string): Promise<boolean> {
  if (!config.systemFromEmail) return false;
  const domain = config.systemFromEmail.split('@')[1];
  const row = await one<{ account_id: string }>(
    `SELECT account_id FROM domains WHERE name = $1 AND status IN ('verified', 'degraded') AND sender_id IS NULL ORDER BY created_at LIMIT 1`,
    [domain],
  );
  if (!row) {
    console.warn(`SYSTEM_FROM_EMAIL ${config.systemFromEmail}: no verified domain ${domain} in any account; system email not sent`);
    return false;
  }
  const account = await one('SELECT * FROM accounts WHERE id = $1', [row.account_id]);
  await enqueueEmail(account, {
    from: { email: config.systemFromEmail, name: config.systemFromName },
    to: [to],
    subject,
    html,
    type: 'transactional',
    metadata: { system: true },
  } as any);
  return true;
}
