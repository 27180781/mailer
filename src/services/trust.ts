import { config } from '../config.js';
import { one, query } from '../db.js';
import { emitEvent } from './webhooks.js';

/**
 * Automatic, gradual trust instead of manual account approval.
 * New accounts start small; clean sending raises the daily limit step by step; bad bounce or
 * complaint rates suspend the account at once, so one bad actor can't hurt the shared SES reputation.
 */
export const TRUST_LEVELS = [
  { level: 0, name: 'חדש', limit: () => config.newAccountDailyLimit, minDays: 0 },
  { level: 1, name: 'מאומת', limit: () => 1_000, minDays: 0 },
  { level: 2, name: 'מבוסס', limit: () => 5_000, minDays: 3 },
  { level: 3, name: 'ותיק', limit: () => 20_000, minDays: 7 },
  { level: 4, name: 'מוביל', limit: () => 50_000, minDays: 30 },
];

const MIN_SENT_TO_PROMOTE = 50;
const MAX_BOUNCE_TO_PROMOTE = 0.02;
const MAX_COMPLAINT_TO_PROMOTE = 0.001;
const MIN_SENT_TO_SUSPEND = 100;
const SUSPEND_BOUNCE = 0.05;
const SUSPEND_COMPLAINT = 0.003;

async function sendingHealth(accountId: string) {
  const row = await one<{ sent: number; bounced: number; complained: number }>(
    `SELECT count(*) FILTER (WHERE status IN ('sent','delivered','bounced','complained'))::int AS sent,
            count(*) FILTER (WHERE status = 'bounced')::int AS bounced,
            count(*) FILTER (WHERE status = 'complained')::int AS complained
     FROM messages WHERE account_id = $1 AND NOT test AND created_at > now() - interval '7 days'`,
    [accountId],
  );
  const sent = row?.sent ?? 0;
  return { sent, bounceRate: sent ? row!.bounced / sent : 0, complaintRate: sent ? row!.complained / sent : 0 };
}

async function readiness(account: any) {
  const d = await one<{ n: number }>(`SELECT count(*)::int AS n FROM domains WHERE account_id = $1 AND status = 'verified'`, [account.id]);
  return { domain: (d?.n ?? 0) > 0, legal: !!(account.company_name && account.company_address) };
}

/** What the account needs for the next level, in Hebrew, for the dashboard. */
export async function trustInfo(account: any) {
  const level = TRUST_LEVELS[account.trust_level] ?? TRUST_LEVELS[0];
  const next = TRUST_LEVELS[account.trust_level + 1];
  const health = await sendingHealth(account.id);
  let nextStep: string | null = null;
  if (account.status === 'suspended') nextStep = account.paused_reason || 'החשבון מושעה. לבירור פנו לתמיכה';
  else if (!next) nextStep = null;
  else if (account.trust_level === 0) {
    const r = await readiness(account);
    const missing = [!r.domain && 'לאמת דומיין שליחה', !r.legal && 'למלא שם עסק וכתובת בהגדרות'].filter(Boolean);
    nextStep = `כדי להגיע ל-${next.limit().toLocaleString('he-IL')} מיילים ביום ולשלוח דיוורים: ${missing.join(' ו')}`;
  } else {
    const days = Math.max(0, next.minDays - Math.floor((Date.now() - new Date(account.trust_changed_at).getTime()) / 86_400_000));
    const parts = [days > 0 && `עוד ${days} ימים`, health.sent < MIN_SENT_TO_PROMOTE && `לשלוח לפחות ${MIN_SENT_TO_PROMOTE} מיילים`].filter(Boolean);
    nextStep = `המכסה תעלה אוטומטית ל-${next.limit().toLocaleString('he-IL')} ביום${parts.length ? ` אחרי ${parts.join(' ו')}` : ''}, כל עוד החזרות נמוכות מ-2% והתלונות מ-0.1%`;
  }
  return { level: level.level, name: level.name, daily_limit: account.daily_limit, manual: account.trust_manual, next_level: next ? { name: next.name, limit: next.limit() } : null, next_step: nextStep, health };
}

async function setLevel(account: any, level: number, extra: { activate?: boolean } = {}) {
  const limit = Math.max(account.daily_limit, TRUST_LEVELS[level].limit());
  await query(
    `UPDATE accounts SET trust_level = $2, trust_changed_at = now(), daily_limit = $3, status = CASE WHEN $4::boolean THEN 'active' ELSE status END WHERE id = $1`,
    [account.id, level, limit, !!extra.activate],
  );
  console.log(`trust: account ${account.id} → level ${level} (${limit}/day)`);
}

/** Runs every hour from the worker. */
export async function runAutoTrust() {
  if (process.env.AUTO_TRUST === 'false') return;
  const accounts = await query(
    `SELECT a.* FROM accounts a WHERE a.status IN ('pending', 'active')
       AND NOT EXISTS (SELECT 1 FROM users u WHERE u.account_id = a.id AND u.is_superadmin)`,
  );
  for (const a of accounts) {
    const health = await sendingHealth(a.id);
    // Safety first: applies even to accounts whose limits an admin set by hand
    if (health.sent >= MIN_SENT_TO_SUSPEND && (health.bounceRate >= SUSPEND_BOUNCE || health.complaintRate >= SUSPEND_COMPLAINT)) {
      const reason = `השליחה הושעתה אוטומטית: ${(health.bounceRate * 100).toFixed(1)}% חזרות ו-${(health.complaintRate * 100).toFixed(2)}% תלונות בשבוע האחרון. לבירור פנו לתמיכה`;
      await query(`UPDATE accounts SET status = 'suspended', paused_reason = $2 WHERE id = $1`, [a.id, reason]);
      await emitEvent(a.id, 'account.suspended', { reason, health });
      console.warn(`trust: account ${a.id} suspended (${reason})`);
      continue;
    }
    if (a.trust_manual) continue;
    if (a.trust_level === 0) {
      const r = await readiness(a);
      if (r.domain && r.legal) await setLevel(a, 1, { activate: true });
      continue;
    }
    const next = TRUST_LEVELS[a.trust_level + 1];
    if (!next || a.status !== 'active') continue;
    const days = (Date.now() - new Date(a.trust_changed_at).getTime()) / 86_400_000;
    if (days >= next.minDays && health.sent >= MIN_SENT_TO_PROMOTE && health.bounceRate < MAX_BOUNCE_TO_PROMOTE && health.complaintRate < MAX_COMPLAINT_TO_PROMOTE) {
      await setLevel(a, next.level);
    }
  }
}
