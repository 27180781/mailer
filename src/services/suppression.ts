import { one, query } from '../db.js';

/**
 * Returns the suppression reason for an address, or null.
 * Hard bounces are global. Complaints block everything from that account.
 * Unsubscribes block marketing only; transactional mail (invoices) still goes out.
 */
export async function suppressionReason(accountId: string, email: string, kind: string): Promise<string | null> {
  const row = await one<{ reason: string }>(
    `SELECT reason FROM suppressions
     WHERE email = $2 AND (account_id IS NULL OR account_id = $1)
       AND (reason IN ('bounce', 'complaint', 'manual') OR $3 <> 'transactional')
     ORDER BY account_id NULLS FIRST LIMIT 1`,
    [accountId, email.toLowerCase(), kind],
  );
  return row?.reason ?? null;
}

export async function suppress(accountId: string | null, email: string, reason: string) {
  const e = email.toLowerCase();
  if (accountId === null) {
    await query(`INSERT INTO suppressions (account_id, email, reason) VALUES (NULL, $1, $2) ON CONFLICT (email) WHERE account_id IS NULL DO NOTHING`, [e, reason]);
  } else {
    await query(
      `INSERT INTO suppressions (account_id, email, reason) VALUES ($1, $2, $3)
       ON CONFLICT (account_id, email) WHERE account_id IS NOT NULL DO UPDATE SET reason = CASE WHEN suppressions.reason = 'unsubscribe' THEN EXCLUDED.reason ELSE suppressions.reason END`,
      [accountId, e, reason],
    );
  }
}

export async function unsubscribeContact(accountId: string, email: string) {
  await suppress(accountId, email, 'unsubscribe');
  await query(`UPDATE contacts SET status = 'unsubscribed', updated_at = now() WHERE account_id = $1 AND email = $2 AND status = 'active'`, [accountId, email.toLowerCase()]);
  await query(
    `UPDATE list_members SET status = 'unsubscribed' WHERE contact_id IN (SELECT id FROM contacts WHERE account_id = $1 AND email = $2)`,
    [accountId, email.toLowerCase()],
  );
}
