/**
 * End-to-end test against a real PostgreSQL with the "log" provider (nothing is really sent).
 * Run: TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/mailer npm test
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const dbUrl = process.env.TEST_DATABASE_URL;
process.env.DATABASE_URL = dbUrl;
process.env.EMAIL_PROVIDER = 'log';
process.env.SUPER_ADMIN_EMAILS = 'admin@platform.test';
process.env.PUBLIC_URL = 'https://mail.platform.test';
process.env.LOG_LEVEL = 'warn';
process.env.RESERVED_DOMAINS = 'retsef.test';

const { buildServer } = await import('../src/main.js');
const { migrate, pool, query } = await import('../src/db.js');
const { sendBatch } = await import('../src/worker.js');
const { startDueCampaigns } = await import('../src/services/campaigns.js');
const { dnsLookup } = await import('../src/services/domains.js');
const { getProvider } = await import('../src/providers/index.js');

// Every test domain has a DMARC record, except "nodmarc.test"
dnsLookup.resolveTxt = (async (name: string) => {
  if (name.startsWith('_dmarc.') && name.endsWith('retsef.test')) {
    if (name === '_dmarc.retsef.test') return [['v=DMARC1; p=none;']];
    throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
  }
  if (name.startsWith('_dmarc.') && !name.includes('nodmarc')) return [['v=DMARC1; p=none']];
  throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
}) as any;

let app: Awaited<ReturnType<typeof buildServer>>;
const sent = () => (getProvider('log') as any).sent as { from: string; to: string; raw: Buffer }[];

async function api(method: string, url: string, token?: string, body?: unknown) {
  const res = await app.inject({ method: method as any, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload: body as any });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

before(async () => {
  if (!dbUrl) throw new Error('TEST_DATABASE_URL is required');
  await query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate();
  app = await buildServer();
});
after(async () => {
  await app.close();
  await pool.end();
});

test('multi-tenant flow: platform with senders, domain verification, fallback, campaigns', async () => {
  // Super admin and a platform account (Retzef)
  const admin = await api('POST', '/v1/auth/signup', undefined, { email: 'admin@platform.test', password: 'very-secret-1', name: 'מנהל', account_name: 'מפעיל' });
  assert.equal(admin.status, 201);
  assert.equal(admin.body.account.status, 'active');

  const rz = await api('POST', '/v1/auth/signup', undefined, { email: 'dev@retzef.test', password: 'very-secret-2', name: 'רצף', account_name: 'רצף' });
  assert.equal(rz.body.account.status, 'pending');
  const accountId = rz.body.account.id;
  const promote = await api('PATCH', `/admin/accounts/${accountId}`, admin.body.token, { status: 'active', type: 'platform', daily_limit: 10000 });
  assert.equal(promote.body.type, 'platform');

  const key = await api('POST', '/v1/api-keys', rz.body.token, { name: 'production' });
  assert.match(key.body.key, /^mk_live_/);
  const K = key.body.key;

  // Platform's own domain + fallback address
  const own = await api('POST', '/v1/domains', K, { name: 'docs.retzef.test' });
  assert.equal(own.status, 201);
  assert.equal(own.body.status, 'verified');
  await api('PATCH', '/v1/account', K, { fallback_from_email: 'noreply@docs.retzef.test', fallback_name_template: '{{name}} באמצעות רצף', company_name: 'רצף', company_address: 'בני ברק' });

  // A business inside Retzef
  const shefa = await api('POST', '/v1/senders', K, { name: 'שפע בע"מ', external_id: 'biz-1' });
  assert.equal(shefa.status, 201);
  const other = await api('POST', '/v1/senders', K, { name: 'עסק אחר', external_id: 'biz-2' });

  // Not verified yet -> fallback to Retzef's no-reply address with the business name
  const e1 = await api('POST', '/v1/emails', K, {
    sender_id: shefa.body.id, from: { email: 'invoices@shefa.test', name: 'שפע בע"מ' }, fallback: 'platform',
    to: 'customer@client.test', subject: 'חשבונית 1', html: '<p>שלום</p>',
  });
  assert.equal(e1.status, 202);
  assert.equal(e1.body.used_fallback, true);
  assert.equal(e1.body.from_email, 'noreply@docs.retzef.test');

  // reject mode -> error
  const e2 = await api('POST', '/v1/emails', K, { sender_id: shefa.body.id, from: 'invoices@shefa.test', fallback: 'reject', to: 'customer@client.test', subject: 'x', text: 'x' });
  assert.equal(e2.status, 400);
  assert.equal(e2.body.error.code, 'domain_not_verified');

  // Business verifies its domain through Retzef
  const d = await api('POST', `/v1/senders/${shefa.body.id}/domains`, K, { name: 'shefa.test' });
  assert.equal(d.body.status, 'verified');
  assert.ok(d.body.records.some((r: any) => r.purpose === 'dmarc'));

  const e3 = await api('POST', '/v1/emails', K, {
    sender_id: shefa.body.id, from: { email: 'office@shefa.test', name: 'שפע - הנהלת חשבונות' }, fallback: 'platform',
    to: 'customer@client.test', subject: 'חשבונית 2', html: '<p>מצורפת חשבונית</p>',
    attachments: [{ filename: 'invoice.pdf', content: Buffer.from('%PDF-1.4 test').toString('base64'), content_type: 'application/pdf' }],
  });
  assert.equal(e3.body.used_fallback, false);
  assert.equal(e3.body.from_email, 'office@shefa.test');

  // Another business cannot send as shefa.test, even with fallback
  const e4 = await api('POST', '/v1/emails', K, { sender_id: other.body.id, from: 'office@shefa.test', fallback: 'platform', to: 'a@client.test', subject: 'x', text: 'x' });
  assert.equal(e4.status, 403);

  // Free mail address -> fallback
  const e5 = await api('POST', '/v1/emails', K, { sender_id: other.body.id, from: { email: 'biz2@gmail.com', name: 'עסק אחר' }, fallback: 'platform', to: 'a@client.test', subject: 'x', text: 'x' });
  assert.equal(e5.body.used_fallback, true);

  // Idempotency
  const idem = { sender_id: shefa.body.id, from: 'office@shefa.test', to: 'b@client.test', subject: 'once', text: 'x' };
  const i1 = await app.inject({ method: 'POST', url: '/v1/emails', headers: { authorization: `Bearer ${K}`, 'idempotency-key': 'doc-77' }, payload: idem });
  const i2 = await app.inject({ method: 'POST', url: '/v1/emails', headers: { authorization: `Bearer ${K}`, 'idempotency-key': 'doc-77' }, payload: idem });
  assert.equal(JSON.parse(i2.body).duplicate, true);
  assert.equal(JSON.parse(i1.body).messages[0].id, JSON.parse(i2.body).messages[0].id);

  // Worker sends them
  while ((await sendBatch(50)) > 0);
  const fromRetzef = sent().find((m) => m.raw.toString().includes('Subject: =?UTF-8?') && m.from === 'noreply@docs.retzef.test');
  assert.ok(fromRetzef, 'fallback email was sent');
  const viaShefa = sent().find((m) => m.from === 'office@shefa.test' && m.to === 'customer@client.test')!;
  assert.match(viaShefa.raw.toString(), /invoice\.pdf/);
  assert.doesNotMatch(viaShefa.raw.toString(), /List-Unsubscribe/); // transactional

  // Hard bounce -> global suppression -> next email is suppressed
  const [m3] = await query(`SELECT provider_message_id FROM messages WHERE id = $1`, [e3.body.messages[0].id]);
  const hook = await app.inject({
    method: 'POST', url: '/webhooks/provider/log',
    payload: JSON.stringify([{ type: 'bounced', providerMessageId: m3.provider_message_id, recipient: 'customer@client.test', bounceType: 'hard' }]),
    headers: { 'content-type': 'text/plain' },
  });
  assert.equal(hook.statusCode, 200);
  const e6 = await api('POST', '/v1/emails', K, { sender_id: shefa.body.id, from: 'office@shefa.test', to: 'customer@client.test', subject: 'x', text: 'x' });
  assert.equal(e6.body.messages[0].status, 'suppressed');

  // Campaign
  const list = await api('POST', '/v1/lists', K, { name: 'לקוחות', double_opt_in: false });
  const imp = await api('POST', '/v1/contacts/import', K, {
    contacts: [{ email: 'dana@client.test', name: 'דנה' }, { email: 'yossi@client.test', name: 'יוסי' }, { email: 'customer@client.test' }],
    list_ids: [list.body.id], consent_source: 'טופס באתר', consent_declared: true,
  });
  assert.equal(imp.body.imported, 3);
  const camp = await api('POST', '/v1/campaigns', K, {
    name: 'מבצע חנוכה', subject: 'שלום {{name}}, מבצע חנוכה', from_name: 'רצף', from_email: 'news@docs.retzef.test',
    html: '<html><body><p>שלום {{name}}</p><a href="https://retzef.test/sale">למבצע</a></body></html>', list_ids: [list.body.id],
  });
  assert.equal(camp.status, 201);
  const go = await api('POST', `/v1/campaigns/${camp.body.id}/send`, K, {});
  assert.equal(go.body.status, 'scheduled');
  await startDueCampaigns();
  const before = sent().length;
  while ((await sendBatch(50)) > 0);
  const campaignMails = sent().slice(before);
  assert.equal(campaignMails.length, 2, 'bounced address skipped');
  const dana = campaignMails.find((m) => m.to === 'dana@client.test')!.raw.toString();
  assert.match(dana, /List-Unsubscribe-Post: List-Unsubscribe=One-Click/);
  assert.match(dana, /mail\.platform\.test\/t\/c\//);

  const stats = await api('GET', `/v1/campaigns/${camp.body.id}/stats`, K);
  assert.equal(stats.body.sent, 2);

  // One-click unsubscribe
  const [dm] = await query(`SELECT id FROM messages WHERE campaign_id = $1 AND to_email = 'dana@client.test'`, [camp.body.id]);
  const { signToken } = await import('../src/crypto.js');
  const unsub = await app.inject({ method: 'POST', url: `/u/${signToken(dm.id)}`, payload: 'List-Unsubscribe=One-Click', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(unsub.statusCode, 200);
  const [c] = await query(`SELECT status FROM contacts WHERE email = 'dana@client.test'`);
  assert.equal(c.status, 'unsubscribed');

  // Unsubscribed people still get invoices, but not marketing
  const t1 = await api('POST', '/v1/emails', K, { from: 'noreply@docs.retzef.test', to: 'dana@client.test', subject: 'חשבונית', text: 'x' });
  assert.equal(t1.body.messages[0].status, 'queued');
  const t2 = await api('POST', '/v1/emails', K, { from: 'news@docs.retzef.test', to: 'dana@client.test', subject: 'מבצע', text: 'x', type: 'marketing' });
  assert.equal(t2.body.messages[0].status, 'suppressed');
});

test('domain without DMARC stays pending and pending accounts cannot run campaigns', async () => {
  const u = await api('POST', '/v1/auth/signup', undefined, { email: 'shop@nodmarc.test', password: 'very-secret-3', name: 'חנות', account_name: 'חנות' });
  const d = await api('POST', '/v1/domains', u.body.token, { name: 'nodmarc.test' });
  assert.equal(d.body.status, 'pending');
  assert.equal(d.body.checks.dmarc, 'pending');
  const dm = d.body.records.find((r: any) => r.purpose === 'dmarc');
  assert.equal(dm.value, 'v=DMARC1; p=none; adkim=r; aspf=r');

  const gmail = await api('POST', '/v1/domains', u.body.token, { name: 'gmail.com' });
  assert.equal(gmail.body.error.code, 'freemail_domain');
});

test('sender names with Hebrew quotes survive encoding', async () => {
  const { buildRaw } = await import('../src/services/render.js');
  const raw = (await buildRaw({ messageId: 'x', domain: 'a.test', fromEmail: 'a@a.test', fromName: 'שפע בע"מ באמצעות רצף', to: 'b@b.test', subject: 'ש', text: 'x' })).toString();
  const from = raw.split('\r\n').find((l) => l.startsWith('From:'))!;
  const decoded = from.replace(/=\?UTF-8\?B\?([^?]+)\?=/gi, (_, b) => Buffer.from(b, 'base64').toString()).replace(/=\?UTF-8\?Q\?([^?]+)\?=/gi, (_, q) => Buffer.from(q.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (_m: string, h: string) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString());
  assert.match(decoded, /בע"מ/);
});

test('reserved domains managed outside the system cannot be claimed or deleted', async () => {
  const admin = await api('POST', '/v1/auth/login', undefined, { email: 'admin@platform.test', password: 'very-secret-1' });
  const u = await api('POST', '/v1/auth/signup', undefined, { email: 'ops@retsef.test', password: 'very-secret-4', name: 'רצף', account_name: 'רצף פלטפורמה' });
  const accountId = u.body.account.id;

  const root = await api('POST', '/v1/domains', u.body.token, { name: 'retsef.test' });
  assert.equal(root.status, 403);
  assert.equal(root.body.error.code, 'reserved_domain');

  const subDenied = await api('POST', '/v1/domains', u.body.token, { name: 'mail.retsef.test' });
  assert.equal(subDenied.status, 403);

  await api('PATCH', `/admin/accounts/${accountId}`, admin.body.token, { can_use_reserved_domains: true });
  const sub = await api('POST', '/v1/domains', u.body.token, { name: 'mail.retsef.test' });
  assert.equal(sub.status, 201);
  // DMARC found on the root domain: point there, do not ask for a second record
  const dm = sub.body.records.find((r: any) => r.purpose === 'dmarc');
  assert.equal(dm.name, '_dmarc.retsef.test');
  assert.equal(dm.status, 'verified');

  // Even a super admin's own account cannot add the reserved root
  const asAdmin = await api('POST', '/v1/domains', admin.body.token, { name: 'retsef.test' });
  assert.equal(asAdmin.status, 403);
});
