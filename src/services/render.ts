import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { config } from '../config.js';
import { hmac, signToken } from '../crypto.js';

export interface Attachment {
  filename: string;
  content: string; // base64
  content_type?: string;
}

export interface BuildInput {
  messageId: string;
  /** Full Message-ID header, e.g. <abc@example.co.il>. Default: <messageId@domain> */
  messageIdHeader?: string | null;
  domain: string;
  fromEmail: string;
  fromName?: string | null;
  to: string | string[];
  cc?: string[];
  replyTo?: string | null;
  subject: string;
  html?: string | null;
  text?: string | null;
  headers?: Record<string, string>;
  attachments?: Attachment[] | null;
}

export async function buildRaw(input: BuildInput): Promise<Buffer> {
  const mail = new MailComposer({
    from: input.fromName ? { name: input.fromName, address: input.fromEmail } : input.fromEmail,
    to: input.to,
    cc: input.cc?.length ? input.cc : undefined,
    replyTo: input.replyTo || undefined,
    subject: input.subject,
    html: input.html || undefined,
    text: input.text || (input.html ? htmlToText(input.html) : undefined),
    messageId: input.messageIdHeader || `<${input.messageId}@${input.domain}>`,
    headers: input.headers,
    attachments: (input.attachments ?? []).map((a) => ({
      filename: a.filename,
      content: Buffer.from(a.content, 'base64'),
      contentType: a.content_type,
    })),
  });
  return new Promise((resolve, reject) => mail.compile().build((err, msg) => (err ? reject(err) : resolve(msg))));
}

export function htmlToText(html: string) {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Replaces {{name}}, {{email}} and {{attr.key}} (also {{שם}}). Values are HTML-escaped when html=true. */
export function personalize(template: string, vars: Record<string, unknown>, html: boolean) {
  return template.replace(/\{\{\s*([^}\s]+)\s*\}\}/g, (_, key: string) => {
    const path = key === 'שם' ? 'name' : key === 'מייל' ? 'email' : key;
    const value = path.split('.').reduce<any>((o, k) => (o == null ? undefined : o[k]), vars);
    const s = value == null ? '' : String(value);
    return html ? escapeHtml(s) : s;
  });
}

export const unsubscribeUrl = (messageId: string) => `${config.publicUrl}/u/${signToken(messageId)}`;
export const openPixelUrl = (messageId: string) => `${config.publicUrl}/t/o/${signToken(messageId)}`;
export function clickUrl(messageId: string, url: string) {
  const sig = hmac(`${messageId}|${url}`).slice(0, 16);
  return `${config.publicUrl}/t/c/${signToken(messageId)}?u=${encodeURIComponent(url)}&s=${sig}`;
}
export const clickSigValid = (messageId: string, url: string, sig: string) => hmac(`${messageId}|${url}`).slice(0, 16) === sig;

/** Rewrites http(s) links for click tracking and appends an open pixel. Unsubscribe links are left as is. */
export function addTracking(html: string, messageId: string) {
  const unsub = unsubscribeUrl(messageId);
  let out = html.replace(/(<a\b[^>]*?\bhref\s*=\s*)(["'])(https?:\/\/[^"']+)\2/gi, (m, pre, q, url) => {
    const real = url.replace(/&amp;/g, '&');
    if (real === unsub || real.startsWith(`${config.publicUrl}/u/`)) return m;
    return `${pre}${q}${escapeHtml(clickUrl(messageId, real))}${q}`;
  });
  const pixel = `<img src="${openPixelUrl(messageId)}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0">`;
  out = /<\/body>/i.test(out) ? out.replace(/<\/body>/i, `${pixel}</body>`) : out + pixel;
  return out;
}

export interface FooterInfo {
  company_name?: string | null;
  company_address?: string | null;
  contact_email?: string | null;
}

/** Hebrew legal footer for advertising mail: who sent it, how to reach them, how to unsubscribe. */
export function advertisingFooter(info: FooterInfo, unsubUrl: string) {
  const parts = [info.company_name, info.company_address, info.contact_email].filter(Boolean).map((s) => escapeHtml(String(s)));
  return `<div dir="rtl" style="margin-top:32px;padding-top:16px;border-top:1px solid #ddd;font-family:Arial,sans-serif;font-size:12px;color:#666;text-align:center;line-height:1.6">
${parts.length ? `<div>${parts.join(' · ')}</div>` : ''}
<div>קיבלת את המייל הזה כי נרשמת לקבלת עדכונים. <a href="${unsubUrl}" style="color:#666">להסרה מרשימת התפוצה לחצו כאן</a></div>
</div>`;
}

export function insertFooter(html: string, footer: string) {
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${footer}</body>`) : html + footer;
}

/** Israeli law requires the word "פרסומת" at the start of the subject of advertising mail. */
export function advertisingSubject(subject: string) {
  return /^\s*פרסומת/.test(subject) ? subject : `פרסומת: ${subject}`;
}

export function listUnsubscribeHeaders(messageId: string): Record<string, string> {
  return {
    'List-Unsubscribe': `<${unsubscribeUrl(messageId)}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}
