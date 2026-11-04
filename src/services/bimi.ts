import { config } from '../config.js';
import { findDmarcRecord } from './domains.js';

/**
 * BIMI: the sender's logo next to the message in the inbox.
 * Requirements: an SVG Tiny Portable/Secure logo hosted over HTTPS, a DMARC policy of
 * quarantine or reject (at 100%), and a TXT record at default._bimi.<domain>.
 * Gmail and Apple Mail also require a mark certificate (VMC or CMC); Yahoo and AOL don't.
 */

const MAX_SVG_BYTES = 32 * 1024;

/** Checks the SVG Tiny PS profile rules that mailbox providers enforce. Returns Hebrew error messages. */
export function validateBimiSvg(svg: string): string[] {
  const errors: string[] = [];
  const text = svg.trim();
  if (Buffer.byteLength(text, 'utf8') > MAX_SVG_BYTES) errors.push('הקובץ גדול מ-32KB');
  const root = text.match(/<svg\b[^>]*>/i)?.[0];
  if (!root) return ['זה לא קובץ SVG'];
  if (!/baseProfile\s*=\s*["']tiny-ps["']/i.test(root)) errors.push('חסר baseProfile="tiny-ps" בתגית svg (נדרש פורמט SVG Tiny PS)');
  if (!/version\s*=\s*["']1\.2["']/i.test(root)) errors.push('חסר version="1.2" בתגית svg');
  if (!/<title\b[^>]*>[^<]+<\/title>/i.test(text)) errors.push('חסרה תגית <title> עם שם המותג');
  if (/<script\b/i.test(text) || /\son[a-z]+\s*=/i.test(text)) errors.push('אסור שיהיו סקריפטים או אירועים בקובץ');
  if (/<image\b/i.test(text)) errors.push('אסור לשלב תמונות רסטר (PNG/JPG) בתוך ה-SVG');
  if (/<(foreignObject|animate|animateTransform|animateMotion|set)\b/i.test(text)) errors.push('אסורות אנימציות ו-foreignObject');
  if (/(xlink:)?href\s*=\s*["'](?!#)/i.test(text)) errors.push('אסורים קישורים לקבצים חיצוניים');
  if (/\s(x|y)\s*=\s*["'][^"']+["']/.test(root)) errors.push('אסור להגדיר x או y בתגית svg הראשית');
  const vb = root.match(/viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*["']/i);
  if (!vb) errors.push('חסר viewBox בתגית svg');
  else if (Math.abs(Number(vb[1]) - Number(vb[2])) > 0.5) errors.push('הלוגו חייב להיות ריבועי (רוחב וגובה שווים ב-viewBox)');
  return errors;
}

const PEM_RE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/;

export function validateCertificate(pem: string): string[] {
  return PEM_RE.test(pem) ? [] : ['התעודה צריכה להיות בפורמט PEM (טקסט שמתחיל ב-BEGIN CERTIFICATE)'];
}

export const bimiLogoUrl = (domain: string) => `${config.publicUrl}/bimi/${domain}/logo.svg`;
export const bimiCertUrl = (domain: string) => `${config.publicUrl}/bimi/${domain}/certificate.pem`;

export function bimiRecordValue(domain: string, hasCertificate: boolean) {
  return `v=BIMI1; l=${bimiLogoUrl(domain)}; a=${hasCertificate ? bimiCertUrl(domain) : ''};`;
}

/** Reads the effective DMARC policy for the domain (sp= when the record sits on a parent domain). */
export async function dmarcPolicy(domain: string) {
  const rec = await findDmarcRecord(domain);
  if (!rec) return { record: null, policy: 'none', pct: 100, ready: false, location: null as string | null };
  const tags = Object.fromEntries(
    rec.value.split(';').map((t) => t.trim().split('=').map((x) => x.trim())).filter((t) => t.length === 2).map(([k, v]) => [k.toLowerCase(), v.toLowerCase()]),
  );
  const inherited = rec.name !== `_dmarc.${domain}`;
  const policy = (inherited && tags.sp) || tags.p || 'none';
  const pct = tags.pct ? Number(tags.pct) : 100;
  return { record: rec.value, policy, pct, ready: (policy === 'quarantine' || policy === 'reject') && pct === 100, location: rec.name };
}

/** BIMI readiness for a domain row, for the UI and the API. */
export async function bimiStatus(row: any) {
  const record = (row.records ?? []).find((r: any) => r.purpose === 'bimi');
  const dmarc = await dmarcPolicy(row.name);
  const logo = !!row.bimi_svg;
  const certificate = !!row.bimi_certificate;
  const dns = record?.status === 'verified';
  return {
    enabled: logo,
    logo_url: logo ? bimiLogoUrl(row.name) : null,
    certificate,
    dmarc: { policy: dmarc.policy, pct: dmarc.pct, ready: dmarc.ready, record: dmarc.record, location: dmarc.location },
    dns_record: record ? { name: record.name, value: record.value, status: record.status } : null,
    shows_in: logo && dmarc.ready && dns ? (certificate ? ['yahoo', 'aol', 'gmail', 'apple'] : ['yahoo', 'aol']) : [],
  };
}
