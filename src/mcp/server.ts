import type { FastifyInstance } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

/**
 * MCP server: everything a signed-in user can do in the mailer, as tools for Claude.
 * Every tool calls the same REST API with the caller's own token (app.inject), so validation,
 * roles (owner/admin/editor/viewer), quotas and the active business behave exactly as in the UI.
 */

type Call = (method: string, path: string, body?: unknown) => Promise<{ ok: boolean; status: number; data: any; text: string }>;

const qs = (params: Record<string, unknown>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};
const enc = encodeURIComponent;
const READ = { readOnlyHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false } as const;
/** Sends real email to real people */
const SENDS = { readOnlyHint: false, destructiveHint: true, openWorldHint: true } as const;

const email = z.string().describe('Email address');
const id = z.string().describe('ID (UUID)');
const contactRef = z.string().describe('Contact ID or email address');
const limit = z.number().int().min(1).max(500).optional().describe('Max results (default 50)');
const offset = z.number().int().min(0).optional().describe('Skip this many results (paging)');

export function buildMcpServer(call: Call) {
  const server = new McpServer(
    { name: 'mailer', title: 'מערכת הדיוור', version: '1.0.0' },
    {
      instructions: [
        'Hebrew multi-business email platform (newsletters and transactional email) on Amazon SES, with an optional InforUMobile channel.',
        'All tools act as the signed-in user, inside the active business (see whoami / switch_account), with that user\'s role.',
        'Answer the user in Hebrew. Error messages from the system are already in Hebrew: show them as they are.',
        'Before anything that sends email to real people (send_campaign, send_email, send_campaign_test to others) or deletes data, show the user what will happen (business, recipients count, subject, sender, channel, time) and get an explicit yes.',
        'Marketing email in Israel needs consent, the word "פרסומת" at the start of the subject (is_advertisement) and an unsubscribe link (added automatically for SES).',
        'Campaign content is HTML. Personal fields: {{name}}, {{email}}, {{attr.field}}. Keep the layout right-to-left (dir="rtl").',
      ].join('\n'),
    },
  );

  const tool = (name: string, title: string, description: string, shape: Record<string, z.ZodTypeAny>, annotations: object, run: (a: any) => Promise<{ method: string; path: string; body?: unknown }> | { method: string; path: string; body?: unknown }) => {
    (server as any).registerTool(name, { title, description, inputSchema: shape, annotations: { title, ...annotations } }, async (args: any) => {
      const r = await run(args ?? {});
      const res = await call(r.method, r.path, r.body);
      if (!res.ok) {
        const msg = res.data?.error?.message ?? res.text ?? `HTTP ${res.status}`;
        return { isError: true, content: [{ type: 'text', text: `שגיאה (${res.status}): ${msg}` }] };
      }
      return { content: [{ type: 'text', text: typeof res.data === 'string' ? res.data : JSON.stringify(res.data, null, 1) }] };
    });
  };

  // ---------- Account and businesses ----------
  tool('whoami', 'מי אני', 'The signed-in user, the active business, the role in it, daily usage and limits, and the list of businesses the user belongs to.', {}, READ, () => ({ method: 'GET', path: '/v1/me' }));
  tool('list_accounts', 'העסקים שלי', 'Businesses (accounts) the user belongs to, with the role in each.', {}, READ, () => ({ method: 'GET', path: '/v1/accounts' }));
  tool('switch_account', 'מעבר לעסק', 'Make another business the active one for all following tools.', { account_id: id }, WRITE, (a) => ({ method: 'POST', path: '/v1/accounts/switch', body: { account_id: a.account_id } }));
  tool('create_account', 'פתיחת עסק', 'Open another business owned by the user (starts pending, with the new-account daily limit). It becomes the active business.', { name: z.string(), company_address: z.string().optional() }, WRITE, (a) => ({ method: 'POST', path: '/v1/accounts', body: a }));
  tool('update_account_settings', 'הגדרות החשבון', 'Update the active business settings: name, legal footer details (company_name, company_address, contact_email), track_transactional, ad_label_default.', {
    name: z.string().optional(), company_name: z.string().nullable().optional(), company_address: z.string().nullable().optional(), contact_email: z.string().nullable().optional(),
    track_transactional: z.boolean().optional(), ad_label_default: z.boolean().optional(),
  }, WRITE, (a) => ({ method: 'PATCH', path: '/v1/account', body: a }));
  tool('get_stats', 'סטטיסטיקה', 'Daily sent/delivered/opened/clicked/problems for the last N days, totals (including pending delivery and unsubscribes) and counts of contacts, lists and domains.', { days: z.number().int().min(1).max(90).optional() }, READ, (a) => ({ method: 'GET', path: `/v1/stats${qs({ days: a.days })}` }));

  // ---------- Contacts ----------
  tool('search_contacts', 'חיפוש אנשי קשר', 'List contacts. Filters: free-text search (email or name), exact email, list_id, status (active, unsubscribed, bounced, complained). Returns { total, items }.', {
    search: z.string().optional(), email: z.string().optional(), list_id: z.string().optional(), status: z.enum(['active', 'unsubscribed', 'bounced', 'complained']).optional(), limit, offset,
  }, READ, (a) => ({ method: 'GET', path: `/v1/contacts${qs(a)}` }));
  tool('get_contact', 'איש קשר', 'One contact by ID or email, with its lists.', { contact: contactRef }, READ, (a) => ({ method: 'GET', path: `/v1/contacts/${enc(a.contact)}` }));
  tool('upsert_contact', 'הוספה או עדכון איש קשר', 'Create a contact, or update it if the email exists (name, merged attributes), and add it to lists. consent_source = where the marketing consent came from.', {
    email, name: z.string().optional(), attributes: z.record(z.any()).optional(), consent_source: z.string().optional(), list_ids: z.array(z.string()).optional(),
  }, WRITE, (a) => ({ method: 'POST', path: '/v1/contacts', body: a }));
  tool('update_contact', 'עדכון איש קשר', 'Change a contact: email, name, attributes (merged unless replace_attributes), status (unsubscribed = stop marketing; active = resubscribe, needs consent_source), add_list_ids, remove_list_ids.', {
    contact: contactRef, email: z.string().optional(), name: z.string().nullable().optional(), attributes: z.record(z.any()).optional(), replace_attributes: z.boolean().optional(),
    status: z.enum(['active', 'unsubscribed']).optional(), consent_source: z.string().optional(), add_list_ids: z.array(z.string()).optional(), remove_list_ids: z.array(z.string()).optional(),
  }, WRITE, ({ contact, ...body }) => ({ method: 'PATCH', path: `/v1/contacts/${enc(contact)}`, body }));
  tool('delete_contact', 'מחיקת איש קשר', 'Delete a contact for good. To only stop sending, use update_contact with status unsubscribed.', { contact: contactRef }, DESTRUCTIVE, (a) => ({ method: 'DELETE', path: `/v1/contacts/${enc(a.contact)}` }));
  tool('import_contacts', 'ייבוא אנשי קשר', 'Bulk import up to 10,000 contacts into lists. consent_source and consent_declared=true are required by law (the user confirms all recipients agreed to receive marketing). Invalid addresses are skipped and returned.', {
    contacts: z.array(z.object({ email: z.string(), name: z.string().optional(), attributes: z.record(z.any()).optional() })).min(1).max(10000),
    list_ids: z.array(z.string()).optional(), consent_source: z.string(), consent_declared: z.literal(true),
  }, WRITE, (a) => ({ method: 'POST', path: '/v1/contacts/import', body: a }));

  // ---------- Lists ----------
  tool('list_lists', 'רשימות', 'Mailing lists with confirmed member counts.', {}, READ, () => ({ method: 'GET', path: '/v1/lists' }));
  tool('create_list', 'יצירת רשימה', 'Create a mailing list. double_opt_in applies to the public signup form.', { name: z.string(), description: z.string().optional(), double_opt_in: z.boolean().optional() }, WRITE, (a) => ({ method: 'POST', path: '/v1/lists', body: a }));
  tool('update_list', 'עדכון רשימה', 'Rename or change a list.', { list_id: id, name: z.string().optional(), description: z.string().nullable().optional(), double_opt_in: z.boolean().optional() }, WRITE, ({ list_id, ...body }) => ({ method: 'PATCH', path: `/v1/lists/${enc(list_id)}`, body }));
  tool('delete_list', 'מחיקת רשימה', 'Delete a list (contacts stay).', { list_id: id }, DESTRUCTIVE, (a) => ({ method: 'DELETE', path: `/v1/lists/${enc(a.list_id)}` }));
  tool('add_to_list', 'צירוף לרשימה', 'Add existing contacts to a list by email or ID. Unknown emails come back in not_found (create them with upsert_contact).', { list_id: id, emails: z.array(z.string()).optional(), contact_ids: z.array(z.string()).optional() }, WRITE, ({ list_id, ...body }) => ({ method: 'POST', path: `/v1/lists/${enc(list_id)}/members`, body }));
  tool('remove_from_list', 'הוצאה מרשימה', 'Remove a contact from one list.', { list_id: id, contact: contactRef }, WRITE, (a) => ({ method: 'DELETE', path: `/v1/lists/${enc(a.list_id)}/members/${enc(a.contact)}` }));

  // ---------- Templates ----------
  tool('list_templates', 'תבניות', 'Saved email templates.', {}, READ, () => ({ method: 'GET', path: '/v1/templates' }));
  tool('get_template', 'תבנית', 'One template with its HTML.', { template_id: id }, READ, (a) => ({ method: 'GET', path: `/v1/templates/${enc(a.template_id)}` }));
  tool('create_template', 'יצירת תבנית', 'Save an HTML email template.', { name: z.string(), subject: z.string().optional(), html: z.string(), text: z.string().optional() }, WRITE, (a) => ({ method: 'POST', path: '/v1/templates', body: a }));
  tool('update_template', 'עדכון תבנית', 'Change a template.', { template_id: id, name: z.string().optional(), subject: z.string().optional(), html: z.string().optional(), text: z.string().nullable().optional() }, WRITE, ({ template_id, ...body }) => ({ method: 'PATCH', path: `/v1/templates/${enc(template_id)}`, body }));
  tool('delete_template', 'מחיקת תבנית', 'Delete a template.', { template_id: id }, DESTRUCTIVE, (a) => ({ method: 'DELETE', path: `/v1/templates/${enc(a.template_id)}` }));

  // ---------- Campaigns ----------
  tool('list_campaigns', 'דיוורים', 'Campaigns, newest first, with status (draft, scheduled, sending, paused, sent, cancelled).', { limit, offset }, READ, (a) => ({ method: 'GET', path: `/v1/campaigns${qs(a)}` }));
  tool('get_campaign', 'דיוור', 'One campaign: content, lists, channel, InforU groups, schedule, and stats (sent, delivered, pending, opened, clicked, bounced, complained, unsubscribed; InforU numbers in inforu_stats).', { campaign_id: id }, READ, (a) => ({ method: 'GET', path: `/v1/campaigns/${enc(a.campaign_id)}` }));
  const campaignFields = {
    name: z.string().optional().describe('Internal name'), subject: z.string().optional(), from_name: z.string().optional(),
    from_email: z.string().optional().describe('SES: an address on a verified domain of the business. InforU: an approved sender in InforU'),
    reply_to: z.string().nullable().optional(), html: z.string().optional(), text: z.string().nullable().optional(), template_id: z.string().optional(),
    is_advertisement: z.boolean().optional().describe('Prefix "פרסומת:" to the subject (required by law for marketing)'),
    list_ids: z.array(z.string()).optional(), channel: z.enum(['ses', 'inforu']).optional().describe('ses (default) or inforu (the business\'s InforUMobile packages)'),
    inforu_group_ids: z.array(z.number()).optional().describe('InforU contact groups to send to (channel inforu). See inforu_groups'),
  };
  tool('create_campaign', 'יצירת דיוור', 'Create a campaign as a draft. Nothing is sent until send_campaign.', { ...campaignFields, name: z.string(), subject: z.string(), from_name: z.string(), from_email: z.string() }, WRITE, (a) => ({ method: 'POST', path: '/v1/campaigns', body: a }));
  tool('update_campaign', 'עדכון דיוור', 'Change a draft, scheduled or paused campaign.', { campaign_id: id, ...campaignFields }, WRITE, ({ campaign_id, ...body }) => ({ method: 'PATCH', path: `/v1/campaigns/${enc(campaign_id)}`, body }));
  tool('delete_campaign', 'מחיקת דיוור', 'Delete a draft campaign.', { campaign_id: id }, DESTRUCTIVE, (a) => ({ method: 'DELETE', path: `/v1/campaigns/${enc(a.campaign_id)}` }));
  tool('send_campaign_test', 'שליחת בדיקה', 'Send a test of the campaign (subject prefixed [בדיקה]) to up to 5 addresses, through the campaign\'s channel.', { campaign_id: id, to: z.array(z.string()).min(1).max(5) }, SENDS, (a) => ({ method: 'POST', path: `/v1/campaigns/${enc(a.campaign_id)}/test`, body: { to: a.to } }));
  tool('send_campaign', 'שליחת דיוור', 'Send the campaign to its lists/groups now, or at scheduled_at (ISO 8601 with time zone, e.g. 2026-12-01T20:00:00+02:00). REAL EMAIL: confirm with the user first.', { campaign_id: id, scheduled_at: z.string().optional() }, SENDS, (a) => ({ method: 'POST', path: `/v1/campaigns/${enc(a.campaign_id)}/send`, body: a.scheduled_at ? { scheduled_at: a.scheduled_at } : {} }));
  tool('unschedule_campaign', 'ביטול תזמון', 'Move a scheduled campaign back to draft.', { campaign_id: id }, WRITE, (a) => ({ method: 'POST', path: `/v1/campaigns/${enc(a.campaign_id)}/unschedule` }));
  tool('pause_campaign', 'השהיית דיוור', 'Pause a campaign that is sending.', { campaign_id: id }, WRITE, (a) => ({ method: 'POST', path: `/v1/campaigns/${enc(a.campaign_id)}/pause` }));
  tool('resume_campaign', 'המשך דיוור', 'Resume a paused campaign.', { campaign_id: id }, SENDS, (a) => ({ method: 'POST', path: `/v1/campaigns/${enc(a.campaign_id)}/resume` }));
  tool('cancel_campaign', 'ביטול דיוור', 'Cancel a campaign; emails not yet sent will not be sent.', { campaign_id: id }, DESTRUCTIVE, (a) => ({ method: 'POST', path: `/v1/campaigns/${enc(a.campaign_id)}/cancel` }));
  const filter = z.enum(['all', 'sent', 'sent_pending', 'delivered', 'opened', 'not_opened', 'clicked', 'bounced', 'complained', 'unsubscribed', 'failed', 'queued']).optional()
    .describe('sent_pending = left the system, delivery not confirmed yet');
  tool('campaign_recipients', 'נמעני דיוור', 'Who got the campaign and what each did (opened, clicks, unsubscribed, status), filtered. Returns { total, items }.', { campaign_id: id, filter, search: z.string().optional(), limit, offset }, READ, ({ campaign_id, ...q }) => ({ method: 'GET', path: `/v1/campaigns/${enc(campaign_id)}/recipients${qs(q)}` }));
  tool('campaign_links', 'הקלקות לפי קישור', 'Clicks per link in a campaign (total and unique).', { campaign_id: id }, READ, (a) => ({ method: 'GET', path: `/v1/campaigns/${enc(a.campaign_id)}/links` }));
  tool('save_recipients_as_list', 'שמירת נמענים כרשימה', 'Create a new list from campaign recipients matching a filter (e.g. opened, not_opened, clicked), for a follow-up.', { campaign_id: id, name: z.string(), filter, search: z.string().optional() }, WRITE, ({ campaign_id, ...body }) => ({ method: 'POST', path: `/v1/campaigns/${enc(campaign_id)}/recipients/save-list`, body }));
  tool('refresh_inforu_stats', 'רענון נתוני InforU', 'Pull the latest numbers of a campaign sent through InforU (sent, opened, clicks, returned, blocked, unsubscribes).', { campaign_id: id }, WRITE, (a) => ({ method: 'POST', path: `/v1/campaigns/${enc(a.campaign_id)}/inforu-sync` }));

  // ---------- Single emails ----------
  tool('send_email', 'שליחת מייל', 'Send one email (to up to 50 recipients). type transactional (default) or marketing (adds unsubscribe link). from must be on a verified domain. REAL EMAIL: confirm first.', {
    from_email: z.string(), from_name: z.string().optional(), to: z.array(z.string()).min(1).max(50), cc: z.array(z.string()).optional(), bcc: z.array(z.string()).optional(),
    reply_to: z.string().optional(), subject: z.string(), html: z.string().optional(), text: z.string().optional(), type: z.enum(['transactional', 'marketing']).optional(),
    metadata: z.record(z.any()).optional(), scheduled_at: z.string().optional(),
  }, SENDS, ({ from_email, from_name, ...rest }) => ({ method: 'POST', path: '/v1/emails', body: { from: { email: from_email, name: from_name }, ...rest } }));
  tool('list_emails', 'מיילים שנשלחו', 'Single emails sent through the API (not campaigns), filter by status or recipient.', { status: z.string().optional(), to: z.string().optional(), limit, offset }, READ, (a) => ({ method: 'GET', path: `/v1/emails${qs(a)}` }));
  tool('get_email', 'מייל', 'One email with recipients and events (delivered, opened, bounced…). Works for campaign messages too.', { email_id: id }, READ, (a) => ({ method: 'GET', path: `/v1/emails/${enc(a.email_id)}` }));

  // ---------- Domains ----------
  tool('list_domains', 'דומיינים', 'Sending domains and their verification checks (DKIM, MAIL FROM, DMARC).', {}, READ, () => ({ method: 'GET', path: '/v1/domains' }));
  tool('get_domain', 'דומיין', 'One domain with the DNS records to add and the status of each.', { domain_id: id }, READ, (a) => ({ method: 'GET', path: `/v1/domains/${enc(a.domain_id)}` }));
  tool('add_domain', 'הוספת דומיין', 'Add a sending domain; returns the DNS records to publish.', { name: z.string().describe('e.g. mail.example.co.il') }, WRITE, (a) => ({ method: 'POST', path: '/v1/domains', body: { name: a.name } }));
  tool('verify_domain', 'בדיקת דומיין', 'Check the domain DNS records now.', { domain_id: id }, WRITE, (a) => ({ method: 'POST', path: `/v1/domains/${enc(a.domain_id)}/verify`, body: {} }));
  tool('domain_zone_file', 'קובץ DNS', 'The domain records as a BIND zone file (to import into Cloudflare or another DNS host).', { domain_id: id }, READ, (a) => ({ method: 'GET', path: `/v1/domains/${enc(a.domain_id)}/zone` }));

  // ---------- Suppressions, webhooks, keys ----------
  tool('list_suppressions', 'רשימת חסימה', 'Blocked addresses (unsubscribe, bounce, complaint, manual).', { email: z.string().optional(), limit, offset }, READ, (a) => ({ method: 'GET', path: `/v1/suppressions${qs(a)}` }));
  tool('add_suppression', 'חסימת כתובת', 'Block an address from receiving email from this business.', { email, reason: z.enum(['unsubscribe', 'manual']).optional() }, WRITE, (a) => ({ method: 'POST', path: '/v1/suppressions', body: a }));
  tool('remove_suppression', 'הסרת חסימה', 'Unblock an address (only unsubscribe/manual blocks; bounces and complaints stay).', { email }, DESTRUCTIVE, (a) => ({ method: 'DELETE', path: `/v1/suppressions/${enc(a.email)}` }));
  tool('list_webhooks', 'Webhooks', 'Webhook endpoints of the business.', {}, READ, () => ({ method: 'GET', path: '/v1/webhooks' }));
  tool('list_api_keys', 'מפתחות API', 'API keys of the business (prefix only; keys are shown once at creation in the UI).', {}, READ, () => ({ method: 'GET', path: '/v1/api-keys' }));

  // ---------- Team ----------
  tool('list_team', 'צוות', 'Team members with roles, and pending invitations.', {}, READ, () => ({ method: 'GET', path: '/v1/members' }));
  tool('invite_team_member', 'הזמנה לצוות', 'Invite someone by email (role admin, editor or viewer). Returns the invitation link and whether it was emailed.', { email, role: z.enum(['admin', 'editor', 'viewer']).optional() }, WRITE, (a) => ({ method: 'POST', path: '/v1/members/invitations', body: a }));
  tool('change_member_role', 'שינוי הרשאה', 'Change a team member role.', { user_id: id, role: z.enum(['owner', 'admin', 'editor', 'viewer']) }, WRITE, (a) => ({ method: 'PATCH', path: `/v1/members/${enc(a.user_id)}`, body: { role: a.role } }));
  tool('remove_team_member', 'הסרה מהצוות', 'Remove a member from the business.', { user_id: id }, DESTRUCTIVE, (a) => ({ method: 'DELETE', path: `/v1/members/${enc(a.user_id)}` }));

  // ---------- InforU ----------
  tool('inforu_status', 'מצב InforU', 'Whether InforUMobile is connected to the business, and the remaining email package.', {}, READ, () => ({ method: 'GET', path: '/v1/account/inforu' }));
  tool('inforu_groups', 'קבוצות InforU', 'Contact groups in the business\'s InforU account, with mail recipients each (targets for channel inforu).', {}, READ, () => ({ method: 'GET', path: '/v1/account/inforu/groups' }));

  return server;
}

/** Calls the REST API in-process as the given bearer token */
export function apiCaller(app: FastifyInstance, authorization: string): Call {
  return async (method, path, body) => {
    const res = await app.inject({
      method: method as any,
      url: path,
      headers: { authorization, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      payload: body === undefined ? undefined : JSON.stringify(body),
    });
    let data: any = res.body;
    if ((res.headers['content-type'] ?? '').toString().includes('json')) {
      try { data = JSON.parse(res.body); } catch {}
    }
    return { ok: res.statusCode < 400, status: res.statusCode, data, text: res.body };
  };
}
