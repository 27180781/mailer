import type { DnsRecord } from '../providers/types.js';
import { ApiError } from '../errors.js';

/**
 * Adds a domain's sending records to Cloudflare DNS, so customers don't copy records by hand.
 * Uses a token the customer pastes once (never stored), or the operator's own token
 * (CLOUDFLARE_API_TOKEN) for the operator's domains only.
 */

const API = 'https://api.cloudflare.com/client/v4';
/** Replaceable in tests */
export const cf = { fetch: (url: string, init?: RequestInit) => fetch(url, init) };

export interface RecordResult {
  name: string;
  type: string;
  purpose: string;
  action: 'created' | 'updated' | 'unchanged' | 'skipped' | 'error';
  detail?: string;
}

async function call(token: string, method: string, path: string, body?: unknown) {
  const res = await cf.fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) {
    const msg = data.errors?.map((e: any) => e.message).join('; ') || `HTTP ${res.status}`;
    const err = new Error(msg) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return data.result;
}

/** Finds the Cloudflare zone that holds the domain (the domain itself or a parent). */
export async function findZone(token: string, domain: string): Promise<{ id: string; name: string }> {
  const labels = domain.split('.');
  for (let i = 0; i <= labels.length - 2; i++) {
    const name = labels.slice(i).join('.');
    let zones: any[];
    try {
      zones = await call(token, 'GET', `/zones?name=${encodeURIComponent(name)}&status=active`);
    } catch (err: any) {
      if (err.status === 401 || err.status === 403) throw new ApiError(400, 'cloudflare_token_invalid', 'Cloudflare דחה את המפתח. צריך מפתח עם הרשאת Zone · DNS · Edit לדומיין הזה');
      throw new ApiError(502, 'cloudflare_error', `שגיאה מ-Cloudflare: ${err.message}`);
    }
    if (zones?.length) return { id: zones[0].id, name: zones[0].name };
  }
  throw new ApiError(404, 'cloudflare_zone_not_found', `הדומיין ${domain} לא נמצא בחשבון ה-Cloudflare של המפתח, או שלמפתח אין הרשאה אליו`);
}

const norm = (v: string) => v.replace(/^"|"$/g, '').replace(/"\s+"/g, '').replace(/\.$/, '').trim().toLowerCase();

/**
 * Creates or fixes the records in the zone. Rules that protect existing DNS:
 * - DKIM, BIMI and MAIL FROM names belong to us: a record there with another value is updated.
 * - A TXT at the MAIL FROM name is only replaced if it is an SPF record.
 * - DMARC is never changed: created only when the domain has none.
 * - Everything is "DNS only" (never proxied), or verification would fail.
 */
export async function applyRecords(token: string, domain: string, records: DnsRecord[]) {
  const zone = await findZone(token, domain);
  const results: RecordResult[] = [];
  for (const r of records) {
    const base = { name: r.name, type: r.type, purpose: r.purpose };
    if (r.status === 'verified') {
      results.push({ ...base, action: 'skipped', detail: 'כבר מאומת' });
      continue;
    }
    try {
      const existing: any[] = await call(token, 'GET', `/zones/${zone.id}/dns_records?type=${r.type}&name=${encodeURIComponent(r.name)}`);
      const body = {
        type: r.type,
        name: r.name,
        content: r.value,
        ttl: 1,
        ...(r.type === 'CNAME' ? { proxied: false } : {}),
        ...(r.type === 'MX' ? { priority: r.priority ?? 10 } : {}),
        comment: 'mailer: email sending records',
      };
      let target: any = null;
      if (r.type === 'TXT' && r.purpose === 'mail_from_spf') target = existing.find((e) => /^"?v=spf1/i.test(e.content));
      else if (r.type === 'TXT' && r.purpose === 'dmarc') target = existing[0] ?? null;
      else target = existing[0] ?? null;

      if (r.purpose === 'dmarc' && target) {
        results.push({ ...base, action: 'skipped', detail: 'קיימת רשומת DMARC, לא משנים אותה' });
      } else if (target && norm(target.content) === norm(r.value) && (r.type !== 'MX' || target.priority === (r.priority ?? 10)) && !target.proxied) {
        results.push({ ...base, action: 'unchanged' });
      } else if (target) {
        await call(token, 'PATCH', `/zones/${zone.id}/dns_records/${target.id}`, body);
        results.push({ ...base, action: 'updated', detail: `היה: ${target.content}` });
      } else {
        await call(token, 'POST', `/zones/${zone.id}/dns_records`, body);
        results.push({ ...base, action: 'created' });
      }
    } catch (err: any) {
      results.push({ ...base, action: 'error', detail: err.message });
    }
  }
  return { zone: zone.name, results };
}
