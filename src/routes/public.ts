import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { one, query } from '../db.js';
import { signToken, verifyToken } from '../crypto.js';
import { ApiError } from '../errors.js';
import { getProvider } from '../providers/index.js';
import { handleProviderEvents, recordEngagement } from '../services/events.js';
import { unsubscribeContact } from '../services/suppression.js';
import { emitEvent } from '../services/webhooks.js';
import { clickSigValid, escapeHtml } from '../services/render.js';
import { enqueueEmail } from '../services/send.js';

const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

function page(reply: FastifyReply, title: string, body: string, status = 200) {
  reply.code(status).type('text/html; charset=utf-8');
  const ok = status < 400;
  const icon = ok
    ? '<path d="m5 12 5 5L20 7"/>'
    : '<circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16.5v.5"/>';
  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><meta name="robots" content="noindex">
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Heebo:wght@400;600;800&display=swap" rel="stylesheet">
<style>
:root{--bg:#f5f6fb;--card:#fff;--ink:#0f172a;--muted:#64748b;--grad:linear-gradient(135deg,#6d5efc 0%,#4f46e5 45%,#0ea5a4 100%)}
@media (prefers-color-scheme:dark){:root{--bg:#0b0e1a;--card:#131729;--ink:#e8eaf4;--muted:#8a91a8}}
*{box-sizing:border-box}body{font-family:Heebo,Arial,sans-serif;background:var(--bg);color:var(--ink);margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px}
.wrap{max-width:440px;width:100%}.card{background:var(--card);border-radius:20px;overflow:hidden;box-shadow:0 24px 60px -24px rgba(15,23,42,.35)}
.top{background:var(--grad);height:96px;display:flex;align-items:flex-end;justify-content:center}
.badge{width:64px;height:64px;border-radius:20px;background:var(--card);display:grid;place-items:center;transform:translateY(32px);box-shadow:0 10px 24px -10px rgba(15,23,42,.4);color:${ok ? '#4f46e5' : '#c62828'}}
.body{padding:48px 28px 32px;text-align:center}h1{font-size:22px;font-weight:800;margin:0 0 10px}p{line-height:1.7;color:var(--muted);margin:0 0 8px}
button{font:inherit;font-weight:600;background:var(--grad);color:#fff;border:0;border-radius:12px;padding:12px 28px;font-size:16px;cursor:pointer;margin-top:14px;box-shadow:0 8px 20px -8px rgba(79,70,229,.6)}
.foot{text-align:center;color:var(--muted);font-size:12px;margin-top:16px}
</style></head><body><div class="wrap"><div class="card"><div class="top"><div class="badge"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${icon}</svg></div></div>
<div class="body"><h1>${escapeHtml(title)}</h1>${body}</div></div><div class="foot">נשלח באמצעות ${escapeHtml(config.appName)}</div></div></body></html>`;
}

async function messageFromToken(token: string) {
  const id = verifyToken(token);
  if (!id || !/^[0-9a-f-]{36}$/.test(id)) return null;
  return one('SELECT m.id, m.account_id, m.to_email, m.metadata, m.campaign_id, a.name AS account_name FROM messages m JOIN accounts a ON a.id = m.account_id WHERE m.id = $1', [id]);
}

async function doUnsubscribe(msg: any) {
  await unsubscribeContact(msg.account_id, msg.to_email);
  await query(`INSERT INTO events (account_id, message_id, type) VALUES ($1, $2, 'unsubscribed')`, [msg.account_id, msg.id]);
  await emitEvent(msg.account_id, 'email.unsubscribed', { message_id: msg.id, to: msg.to_email, campaign_id: msg.campaign_id, metadata: msg.metadata });
}

export async function publicRoutes(app: FastifyInstance) {
  app.get('/health', async () => ({ ok: true }));

  // BIMI assets: mailbox providers fetch the logo and certificate from here
  app.get('/bimi/:domain/logo.svg', async (req, reply) => {
    const row = await one('SELECT bimi_svg FROM domains WHERE name = $1', [String((req.params as any).domain).toLowerCase()]);
    if (!row?.bimi_svg) return reply.code(404).send('not found');
    reply.header('cache-control', 'public, max-age=3600').type('image/svg+xml');
    return row.bimi_svg;
  });
  app.get('/bimi/:domain/certificate.pem', async (req, reply) => {
    const row = await one('SELECT bimi_certificate FROM domains WHERE name = $1', [String((req.params as any).domain).toLowerCase()]);
    if (!row?.bimi_certificate) return reply.code(404).send('not found');
    reply.header('cache-control', 'public, max-age=3600').type('application/x-pem-file');
    return row.bimi_certificate;
  });

  // Unsubscribe. GET shows a one-button page (so link scanners don't unsubscribe people);
  // POST does it, which is also what Gmail's one-click (RFC 8058) sends.
  app.get('/u/:token', async (req, reply) => {
    const msg = await messageFromToken((req.params as any).token);
    if (!msg) return page(reply, 'הקישור לא תקין', '<p>ייתכן שהקישור הועתק באופן חלקי.</p>', 404);
    return page(
      reply,
      'הסרה מרשימת התפוצה',
      `<p>להסיר את <b>${escapeHtml(msg.to_email)}</b> מהדיוורים של ${escapeHtml(msg.account_name)}?</p>
       <form method="post"><button type="submit">הסירו אותי</button></form>`,
    );
  });
  app.post('/u/:token', async (req, reply) => {
    const msg = await messageFromToken((req.params as any).token);
    if (!msg) return page(reply, 'הקישור לא תקין', '<p>ייתכן שהקישור הועתק באופן חלקי.</p>', 404);
    await doUnsubscribe(msg);
    return page(reply, 'הוסרת מרשימת התפוצה', `<p>לא יישלחו יותר דיוורים מ-${escapeHtml(msg.account_name)} אל ${escapeHtml(msg.to_email)}.</p>`);
  });

  app.get('/t/o/:token', async (req, reply) => {
    const id = verifyToken((req.params as any).token);
    if (id) void recordEngagement(id, 'opened').catch(() => {});
    reply.header('cache-control', 'no-store, max-age=0').type('image/gif');
    return GIF;
  });

  app.get('/t/c/:token', async (req, reply) => {
    const id = verifyToken((req.params as any).token);
    const { u, s } = req.query as { u?: string; s?: string };
    if (!id || !u || !s || !clickSigValid(id, u, s) || !/^https?:\/\//.test(u)) return page(reply, 'הקישור לא תקין', '', 404);
    void recordEngagement(id, 'clicked', { url: u }).catch(() => {});
    return reply.redirect(u, 302);
  });

  // Public subscribe form endpoint (double opt-in when the list requires it)
  app.post('/s/:listId', async (req, reply) => {
    const { listId } = z.object({ listId: z.string().uuid() }).parse(req.params);
    const b = z.object({ email: z.string().trim().toLowerCase().email('כתובת מייל לא תקינה'), name: z.string().max(200).optional() }).parse(req.body);
    const list = await one('SELECT l.*, a.status AS account_status, a.name AS account_name FROM lists l JOIN accounts a ON a.id = l.account_id WHERE l.id = $1', [listId]);
    if (!list || list.account_status === 'suspended') throw new ApiError(404, 'not_found', 'הרשימה לא נמצאה');
    const contact = await one(
      `INSERT INTO contacts (account_id, email, name, consent_source, consent_at, consent_ip) VALUES ($1, $2, $3, $4, now(), $5)
       ON CONFLICT (account_id, email) DO UPDATE SET name = coalesce(EXCLUDED.name, contacts.name), consent_source = EXCLUDED.consent_source,
         consent_at = now(), consent_ip = EXCLUDED.consent_ip, updated_at = now()
       RETURNING *`,
      [list.account_id, b.email, b.name ?? null, `טופס הרשמה: ${list.name}`, req.ip],
    );
    const needsConfirm = list.double_opt_in && list.from_email;
    await query(
      `INSERT INTO list_members (list_id, contact_id, status) VALUES ($1, $2, $3)
       ON CONFLICT (list_id, contact_id) DO UPDATE SET status = CASE WHEN list_members.status = 'confirmed' THEN 'confirmed' ELSE EXCLUDED.status END`,
      [listId, contact.id, needsConfirm ? 'pending' : 'confirmed'],
    );
    if (needsConfirm) {
      const account = await one('SELECT * FROM accounts WHERE id = $1', [list.account_id]);
      const link = `${config.publicUrl}/confirm/${signToken(`${listId}:${contact.id}`)}`;
      await enqueueEmail(account, {
        from: { email: list.from_email, name: list.from_name || account.name },
        to: [b.email],
        subject: `אישור הרשמה לרשימת התפוצה של ${account.name}`,
        html: `<div dir="rtl" style="font-family:Arial,sans-serif;font-size:16px;line-height:1.6">
          <p>שלום${b.name ? ` ${escapeHtml(b.name)}` : ''},</p>
          <p>כדי לאשר את ההרשמה לדיוורים של ${escapeHtml(account.name)} לחצו על הכפתור:</p>
          <p><a href="${link}" style="display:inline-block;background:#1c1917;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none">אישור הרשמה</a></p>
          <p style="color:#78716c;font-size:13px">אם לא נרשמתם, אפשר להתעלם מהמייל הזה.</p></div>`,
        type: 'transactional',
      }).catch((err) => req.log.error(err, 'confirmation email failed'));
    }
    const wantsHtml = (req.headers.accept ?? '').includes('text/html');
    if (wantsHtml) return page(reply, needsConfirm ? 'כמעט סיימנו' : 'נרשמת בהצלחה', needsConfirm ? '<p>שלחנו אליך מייל עם קישור לאישור ההרשמה.</p>' : '');
    return { ok: true, confirmation_required: !!needsConfirm };
  });

  app.get('/confirm/:token', async (req, reply) => {
    const payload = verifyToken((req.params as any).token);
    const [listId, contactId] = payload?.split(':') ?? [];
    if (!listId || !contactId) return page(reply, 'הקישור לא תקין', '', 404);
    const row = await one(`UPDATE list_members SET status = 'confirmed' WHERE list_id = $1 AND contact_id = $2 AND status <> 'unsubscribed' RETURNING list_id`, [listId, contactId]);
    if (row) await query(`UPDATE contacts SET consent_at = now() WHERE id = $1`, [contactId]);
    return page(reply, row ? 'ההרשמה אושרה' : 'הקישור כבר לא בתוקף', row ? '<p>תודה! מעכשיו תקבלו את הדיוורים שלנו.</p>' : '');
  });

  // Provider callbacks (SES via SNS, or any other provider)
  app.post('/webhooks/provider/:name', async (req, reply) => {
    const { name } = req.params as { name: string };
    const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    let provider;
    try {
      provider = getProvider(name);
    } catch {
      reply.code(404);
      return { error: 'unknown provider' };
    }
    try {
      const events = await provider.parseWebhook(req.headers as any, body);
      await handleProviderEvents(events);
      return { ok: true, events: events.length };
    } catch (err: any) {
      req.log.warn({ err }, 'provider webhook rejected');
      reply.code(400);
      return { error: err.message };
    }
  });
}
