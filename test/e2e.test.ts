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

test('DNS zone file download and regional DKIM target', async () => {
  const { zoneFile } = await import('../src/services/domains.js');
  const { dkimDomain } = await import('../src/providers/ses.js');
  assert.equal(dkimDomain('il-central-1'), 'dkim.il-central-1.amazonses.com');
  assert.equal(dkimDomain('eu-central-1'), 'dkim.amazonses.com');

  const zone = zoneFile({
    name: 'mail.example.test',
    records: [
      { type: 'CNAME', name: 'tok._domainkey.mail.example.test', value: 'tok.dkim.il-central-1.amazonses.com', purpose: 'dkim', status: 'pending' },
      { type: 'MX', name: 'bounce.mail.example.test', value: 'feedback-smtp.il-central-1.amazonses.com', priority: 10, purpose: 'mail_from_mx', status: 'pending' },
      { type: 'TXT', name: 'bounce.mail.example.test', value: 'v=spf1 include:amazonses.com ~all', purpose: 'mail_from_spf', status: 'pending' },
      { type: 'TXT', name: '_dmarc.example.test', value: 'v=DMARC1; p=none;', purpose: 'dmarc', status: 'verified' },
    ],
  });
  assert.match(zone, /^tok\._domainkey\.mail\.example\.test\.\t3600\tIN\tCNAME\ttok\.dkim\.il-central-1\.amazonses\.com\. ; cf_tags=cf-proxied:false$/m);
  assert.match(zone, /^bounce\.mail\.example\.test\.\t3600\tIN\tMX\t10 feedback-smtp\.il-central-1\.amazonses\.com\.$/m);
  assert.match(zone, /^bounce\.mail\.example\.test\.\t3600\tIN\tTXT\t"v=spf1 include:amazonses\.com ~all"$/m);
  assert.doesNotMatch(zone, /_dmarc/); // an existing DMARC record is never repeated

  const long = zoneFile({ name: 'a.test', records: [{ type: 'TXT', name: 'mk1._domainkey.a.test', value: 'v=DKIM1; k=rsa; p=' + 'A'.repeat(400), purpose: 'dkim', status: 'pending' }] });
  assert.match(long, /IN\tTXT\t"[^"]{255}" "[^"]+"/);

  // API endpoint returns it as a download
  const u = await api('POST', '/v1/auth/login', undefined, { email: 'dev@retzef.test', password: 'very-secret-2' });
  const [d] = (await api('GET', '/v1/domains', u.body.token)).body;
  const res = await app.inject({ method: 'GET', url: `/v1/domains/${d.id}/zone`, headers: { authorization: `Bearer ${u.body.token}` } });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-disposition']), /attachment; filename="dns-/);
});

test('system-wide daily cap holds mail in the queue instead of sending', async () => {
  const { config } = await import('../src/config.js');
  const { remainingDailyCap } = await import('../src/worker.js');
  const [{ n }] = await query(`SELECT count(*)::int AS n FROM messages WHERE sent_at > now() - interval '24 hours'`);
  config.dailySendCap = n; // already at the cap
  try {
    assert.equal(await remainingDailyCap(), 0);
    const u = await api('POST', '/v1/auth/login', undefined, { email: 'dev@retzef.test', password: 'very-secret-2' });
    const e = await api('POST', '/v1/emails', u.body.token, { from: 'noreply@docs.retzef.test', to: 'cap@client.test', subject: 'cap', text: 'x' });
    assert.equal(e.body.messages[0].status, 'queued');
    assert.equal(await sendBatch(50), 0);
    const [m] = await query(`SELECT status FROM messages WHERE id = $1`, [e.body.messages[0].id]);
    assert.equal(m.status, 'queued');
    config.dailySendCap = n + 1;
    assert.equal(await sendBatch(50), 1);
  } finally {
    config.dailySendCap = 0;
  }
});

test('POST with an empty JSON body is accepted (verify button)', async () => {
  const u = await api('POST', '/v1/auth/login', undefined, { email: 'dev@retzef.test', password: 'very-secret-2' });
  const [d] = (await api('GET', '/v1/domains', u.body.token)).body;
  const res = await app.inject({ method: 'POST', url: `/v1/domains/${d.id}/verify`, headers: { authorization: `Bearer ${u.body.token}`, 'content-type': 'application/json' }, payload: '' });
  assert.equal(res.statusCode, 200);
  const bad = await app.inject({ method: 'POST', url: '/v1/auth/login', headers: { 'content-type': 'application/json' }, payload: '{nope' });
  assert.equal(bad.statusCode, 400);
});

test('threading headers, CC/BCC in one message, per-recipient events', async () => {
  const u = await api('POST', '/v1/auth/login', undefined, { email: 'dev@retzef.test', password: 'very-secret-2' });
  const K = u.body.token;
  const reply = await api('POST', '/v1/emails', K, {
    from: { email: 'agent@docs.retzef.test', name: 'נציג' },
    to: 'lead@client.test', cc: ['boss@client.test'], bcc: 'archive@client.test',
    subject: 'Re: הצעת מחיר', text: 'תודה',
    headers: { 'Message-ID': '<reply-1@docs.retzef.test>', 'In-Reply-To': '<orig-1@client.test>', References: '<orig-1@client.test>' },
  });
  assert.equal(reply.status, 202);
  assert.equal(reply.body.messages.length, 1, 'one message for everyone');
  assert.equal(reply.body.messages[0].message_id_header, '<reply-1@docs.retzef.test>');
  assert.deepEqual(reply.body.messages[0].cc, ['boss@client.test']);

  const before = sent().length;
  while ((await sendBatch(50)) > 0);
  const m = sent().slice(before).find((x) => x.to === 'lead@client.test')!;
  const raw = m.raw.toString();
  assert.deepEqual((m as any).recipients.sort(), ['archive@client.test', 'boss@client.test', 'lead@client.test']);
  assert.match(raw, /^Message-ID: <reply-1@docs\.retzef\.test>/m);
  assert.match(raw, /^In-Reply-To: <orig-1@client\.test>/m);
  assert.match(raw, /^References: <orig-1@client\.test>/m);
  assert.match(raw, /^Cc: boss@client\.test/m);
  assert.doesNotMatch(raw, /archive@client\.test/, 'BCC never in headers');

  // A bounce of the CC recipient is tracked on that recipient only
  const [row] = await query(`SELECT provider_message_id FROM messages WHERE id = $1`, [reply.body.messages[0].id]);
  await app.inject({ method: 'POST', url: '/webhooks/provider/log', headers: { 'content-type': 'text/plain' },
    payload: JSON.stringify([{ type: 'bounced', providerMessageId: row.provider_message_id, recipient: 'boss@client.test', bounceType: 'soft' }, { type: 'delivered', providerMessageId: row.provider_message_id, recipient: 'lead@client.test' }]) });
  const detail = await api('GET', `/v1/emails/${reply.body.messages[0].id}`, K);
  assert.equal(detail.body.status, 'delivered');
  assert.equal(detail.body.recipients.find((r: any) => r.email === 'boss@client.test').status, 'bounced');

  const bad = await api('POST', '/v1/emails', K, { from: 'a@docs.retzef.test', to: ['x@client.test', 'y@client.test'], subject: 'x', text: 'x', headers: { 'Message-ID': '<dup@docs.retzef.test>' } });
  assert.equal(bad.body.error.code, 'message_id_needs_single_message');
  const badHeader = await api('POST', '/v1/emails', K, { from: 'a@docs.retzef.test', to: 'x@client.test', subject: 'x', text: 'x', headers: { 'Bcc': 'evil@x.test' } });
  assert.equal(badHeader.status, 400);
});

test('test API keys simulate sending without sending or suppressing', async () => {
  const u = await api('POST', '/v1/auth/login', undefined, { email: 'dev@retzef.test', password: 'very-secret-2' });
  const key = await api('POST', '/v1/api-keys', u.body.token, { name: 'sandbox', mode: 'test' });
  assert.match(key.body.key, /^mk_test_/);
  const T = key.body.key;
  const before = sent().length;
  // Unverified domain is allowed with a warning in test mode
  const r = await api('POST', '/v1/emails', T, { from: 'hello@not-verified-yet.test', to: ['ok@client.test', 'bounce-1@client.test'], subject: 'בדיקה', text: 'x' });
  assert.equal(r.status, 202);
  assert.equal(r.body.test, true);
  assert.deepEqual(r.body.warnings, ['domain_not_verified']);
  while ((await sendBatch(50)) > 0);
  assert.equal(sent().length, before, 'nothing reached the provider');
  const ok = await api('GET', `/v1/emails/${r.body.messages[0].id}`, T);
  const bounced = await api('GET', `/v1/emails/${r.body.messages[1].id}`, T);
  assert.equal(ok.body.status, 'delivered');
  assert.equal(bounced.body.status, 'bounced');
  const [s] = await query(`SELECT count(*)::int AS n FROM suppressions WHERE email = 'bounce-1@client.test'`);
  assert.equal(s.n, 0, 'simulated bounce does not suppress');
  // Live sends from an unverified domain are still refused
  const live = await api('POST', '/v1/emails', u.body.token, { from: 'hello@not-verified-yet.test', to: 'ok@client.test', subject: 'x', text: 'x' });
  assert.equal(live.body.error.code, 'domain_not_verified');
});

test('BIMI logo validation, hosting and DNS record', async () => {
  const u = await api('POST', '/v1/auth/login', undefined, { email: 'dev@retzef.test', password: 'very-secret-2' });
  const [d] = (await api('GET', '/v1/domains', u.body.token)).body.filter((x: any) => x.name === 'docs.retzef.test');
  const bad = await api('PUT', `/v1/domains/${d.id}/bimi`, u.body.token, { svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><script>x()</script></svg>' });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.error.details.errors.length >= 3);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" version="1.2" baseProfile="tiny-ps" viewBox="0 0 100 100"><title>Retzef</title><rect width="100" height="100" fill="#4f46e5"/></svg>';
  const ok = await api('PUT', `/v1/domains/${d.id}/bimi`, u.body.token, { svg });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.bimi.enabled, true);
  assert.equal(ok.body.bimi.dmarc.ready, false, 'p=none is not enough for BIMI');
  assert.match(ok.body.bimi.dns_record.value, /^v=BIMI1; l=https:\/\/mail\.platform\.test\/bimi\/docs\.retzef\.test\/logo\.svg; a=;$/);
  const logo = await app.inject({ method: 'GET', url: '/bimi/docs.retzef.test/logo.svg' });
  assert.equal(logo.statusCode, 200);
  assert.match(String(logo.headers['content-type']), /image\/svg\+xml/);
  const { zoneFile } = await import('../src/services/domains.js');
  const [row] = await query(`SELECT * FROM domains WHERE id = $1`, [d.id]);
  assert.match(zoneFile(row), /default\._bimi\.docs\.retzef\.test\.\t3600\tIN\tTXT\t"v=BIMI1;/);
});

test('automatic trust: verified domain and legal details activate a new account; bad rates suspend it', async () => {
  const admin = await api('POST', '/v1/auth/login', undefined, { email: 'admin@platform.test', password: 'very-secret-1' });
  const u = await api('POST', '/v1/auth/signup', undefined, { email: 'owner@magnet.test', password: 'very-secret-5', name: 'מגנט', account_name: 'מגנט ADS' });
  assert.equal(u.body.account.status, 'pending');
  let me = await api('GET', '/v1/me', u.body.token);
  assert.match(me.body.trust.next_step, /לאמת דומיין שליחה/);
  await api('POST', '/v1/domains', u.body.token, { name: 'magnet.test' });
  await api('POST', '/admin/trust/run', admin.body.token);
  me = await api('GET', '/v1/me', u.body.token);
  assert.equal(me.body.account.status, 'pending', 'legal details still missing');
  await api('PATCH', '/v1/account', u.body.token, { company_name: 'מגנט ADS', company_address: 'תל אביב' });
  await api('POST', '/admin/trust/run', admin.body.token);
  me = await api('GET', '/v1/me', u.body.token);
  assert.equal(me.body.account.status, 'active');
  assert.equal(me.body.trust.level, 1);
  assert.equal(me.body.account.daily_limit, 1000);

  // 100 bounced messages in the last week → suspended
  await query(`INSERT INTO messages (account_id, kind, to_email, from_email, status, created_at) SELECT $1, 'transactional', 'b'||g||'@x.test', 'a@magnet.test', 'bounced', now() FROM generate_series(1,100) g`, [me.body.account.id]);
  await api('POST', '/admin/trust/run', admin.body.token);
  me = await api('GET', '/v1/me', u.body.token);
  assert.equal(me.body.account.status, 'suspended');
  assert.match(me.body.account.paused_reason, /הושעתה אוטומטית/);
});

test('Cloudflare: adds missing records, keeps an existing DMARC, never stores the token', async () => {
  const { cf } = await import('../src/services/cloudflare.js');
  const calls: { method: string; url: string; body?: any }[] = [];
  const zoneRecords: any[] = [{ id: 'r-dmarc', type: 'TXT', name: '_dmarc.cfshop.test', content: 'v=DMARC1; p=reject' }];
  const real = cf.fetch;
  cf.fetch = (async (url: string, init?: any) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, body });
    const u = new URL(url);
    const json = (result: unknown) => new Response(JSON.stringify({ success: true, result }), { status: 200 });
    if (init?.headers?.authorization !== 'Bearer cf-token-cf-token-cf-token') return new Response(JSON.stringify({ success: false, errors: [{ message: 'Invalid token' }] }), { status: 403 });
    if (u.pathname.endsWith('/zones')) return json(u.searchParams.get('name') === 'cfshop.test' ? [{ id: 'z1', name: 'cfshop.test' }] : []);
    if (u.pathname.endsWith('/dns_records') && method === 'GET') return json(zoneRecords.filter((r) => r.type === u.searchParams.get('type') && r.name === u.searchParams.get('name')));
    if (method === 'POST') { zoneRecords.push({ id: `r${zoneRecords.length}`, ...body }); return json({}); }
    return json({});
  }) as any;
  try {
    const u = await api('POST', '/v1/auth/signup', undefined, { email: 'owner@cfshop.test', password: 'very-secret-6', name: 'חנות', account_name: 'חנות CF' });
    const d = await api('POST', '/v1/domains', u.body.token, { name: 'mail.cfshop.test' });
    const bad = await api('POST', `/v1/domains/${d.body.id}/cloudflare`, u.body.token, { token: 'wrong-token-wrong-token' });
    assert.equal(bad.body.error.code, 'cloudflare_token_invalid');
    const r = await api('POST', `/v1/domains/${d.body.id}/cloudflare`, u.body.token, { token: 'cf-token-cf-token-cf-token' });
    assert.equal(r.status, 200);
    assert.equal(r.body.zone, 'cfshop.test');
    const posts = calls.filter((c) => c.method === 'POST');
    assert.ok(posts.every((p) => p.body.proxied !== true), 'never proxied');
    assert.ok(!posts.some((p) => p.body.name.startsWith('_dmarc')), 'existing DMARC is not touched');
    // Regular customers can't use the operator token
    const op = await api('POST', `/v1/domains/${d.body.id}/cloudflare`, u.body.token, { use_operator: true });
    assert.equal(op.status, 403);
    const [row] = await query(`SELECT * FROM domains WHERE id = $1`, [d.body.id]);
    assert.doesNotMatch(JSON.stringify(row), /cf-token/, 'token not stored');
  } finally {
    cf.fetch = real;
  }
});

test('"Name <email>" address format (Resend compatible)', async () => {
  const u = await api('POST', '/v1/auth/login', undefined, { email: 'dev@retzef.test', password: 'very-secret-2' });
  const r = await api('POST', '/v1/emails', u.body.token, { from: 'דנה ממגנט <dana@docs.retzef.test>', to: ['Lead Person <lead2@client.test>'], reply_to: ['Sales <sales@docs.retzef.test>'], subject: 'x', text: 'x' });
  assert.equal(r.status, 202);
  assert.equal(r.body.from_email, 'dana@docs.retzef.test');
  const [m] = await query(`SELECT from_name, to_email, reply_to FROM messages WHERE id = $1`, [r.body.messages[0].id]);
  assert.equal(m.from_name, 'דנה ממגנט');
  assert.equal(m.to_email, 'lead2@client.test');
  assert.equal(m.reply_to, 'sales@docs.retzef.test');
});
