import { config } from './config.js';
import { query } from './db.js';
import { processMessage } from './services/send.js';
import { startDueCampaigns, superviseCampaigns } from './services/campaigns.js';
import { checkDueDomains } from './services/domains.js';
import { deliverWebhooks } from './services/webhooks.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let running = true;

/** Claims up to `limit` due messages. Transactional mail (priority 0) always goes first. */
async function claim(limit: number) {
  return query(
    `UPDATE messages m SET status = 'sending', attempts = attempts + 1, next_attempt_at = now()
     WHERE m.id IN (
       SELECT m2.id FROM messages m2 LEFT JOIN campaigns c ON c.id = m2.campaign_id
       WHERE m2.status = 'queued' AND m2.next_attempt_at <= now() AND (m2.campaign_id IS NULL OR c.status = 'sending')
       ORDER BY m2.priority, m2.next_attempt_at LIMIT $1 FOR UPDATE OF m2 SKIP LOCKED)
     RETURNING *`,
    [limit],
  );
}

let capWarnedAt = 0;

/** How many more emails may go out under DAILY_SEND_CAP (rolling 24 hours). */
export async function remainingDailyCap(): Promise<number> {
  if (!config.dailySendCap) return Infinity;
  const [row] = await query<{ n: number }>(`SELECT count(*)::int AS n FROM messages WHERE sent_at > now() - interval '24 hours' AND NOT test`);
  return Math.max(0, config.dailySendCap - (row?.n ?? 0));
}

/** Claims and sends one batch. Returns how many messages were handled. */
export async function sendBatch(limit = config.maxSendRate) {
  const remaining = await remainingDailyCap();
  if (remaining <= 0) {
    if (Date.now() - capWarnedAt > 15 * 60_000) {
      console.warn(`daily send cap reached (${config.dailySendCap} in 24h); queued mail waits`);
      capWarnedAt = Date.now();
    }
    return 0;
  }
  const batch = await claim(Math.min(limit, remaining));
  await Promise.all(
    batch.map((m) =>
      processMessage(m).catch(async (err) => {
        console.error(`message ${m.id} crashed`, err);
        await query(`UPDATE messages SET status = 'queued', next_attempt_at = now() + interval '5 minutes', last_error = $2 WHERE id = $1`, [m.id, String(err).slice(0, 500)]);
      }),
    ),
  );
  return batch.length;
}

/** Sends at most MAX_SEND_RATE emails per second. */
async function sendLoop() {
  while (running) {
    const started = Date.now();
    try {
      const n = await sendBatch();
      if (n === 0) await sleep(1000);
      else await sleep(Math.max(0, 1000 - (Date.now() - started)));
    } catch (err) {
      console.error('send loop error', err);
      await sleep(5000);
    }
  }
}

async function every(ms: number, name: string, fn: () => Promise<unknown>) {
  while (running) {
    try {
      await fn();
    } catch (err) {
      console.error(`${name} error`, err);
    }
    await sleep(ms);
  }
}

export function startWorker() {
  console.log(`worker started, provider=${config.provider}, rate=${config.maxSendRate}/s`);
  void sendLoop();
  void every(5_000, 'campaigns', async () => {
    await startDueCampaigns();
    await superviseCampaigns();
  });
  void every(60_000, 'domains', checkDueDomains);
  void every(2_000, 'webhooks', deliverWebhooks);
  // Messages stuck in "sending" after a crash go back to the queue.
  void every(60_000, 'recover', () =>
    query(`UPDATE messages SET status = 'queued' WHERE status = 'sending' AND next_attempt_at < now() - interval '10 minutes'`),
  );
}

export function stopWorker() {
  running = false;
}
