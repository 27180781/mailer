import { resolveTxt } from 'node:dns/promises';
import { one, query } from '../db.js';
import { ApiError } from '../errors.js';
import { config } from '../config.js';
import { getProvider, ProviderError, type DnsRecord } from '../providers/index.js';
import { dkimDomain } from '../providers/ses.js';
import { emitEvent } from './webhooks.js';

/** Free mailbox providers: their DMARC policy forbids sending as them from anywhere else. */
export const FREEMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.il', 'ymail.com', 'hotmail.com', 'hotmail.co.il', 'outlook.com',
  'outlook.co.il', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'gmx.com', 'gmx.net', 'mail.com',
  'walla.co.il', 'walla.com', 'zahav.net.il', 'bezeqint.net', '012.net.il', 'netvision.net.il', 'inter.net.il',
  'proton.me', 'protonmail.com', 'yandex.com', 'mail.ru',
]);

const DOMAIN_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;
const VERIFY_WINDOW_HOURS = 72;

export function domainOf(email: string) {
  return email.split('@')[1]?.toLowerCase() ?? '';
}

export const SUGGESTED_DMARC = 'v=DMARC1; p=none; adkim=r; aspf=r';

/** DNS lookups go through this object so tests can replace them. */
export const dnsLookup = { resolveTxt };

async function txt(name: string): Promise<string[]> {
  try {
    return (await dnsLookup.resolveTxt(name)).map((parts) => parts.join(''));
  } catch {
    return [];
  }
}

/** Looks for a DMARC record on the domain or one of its parents (organizational domain). */
export async function findDmarcRecord(domain: string): Promise<{ name: string; value: string } | null> {
  const labels = domain.split('.');
  for (let i = 0; i <= labels.length - 2; i++) {
    const name = `_dmarc.${labels.slice(i).join('.')}`;
    const rec = (await txt(name)).find((t) => /^v=DMARC1/i.test(t.trim()));
    if (rec) return { name, value: rec };
  }
  return null;
}

export async function findDmarc(domain: string): Promise<string | null> {
  return (await findDmarcRecord(domain))?.value ?? null;
}

/** The reserved domain this name equals or falls under, if any. */
export function reservedParent(name: string): string | null {
  return config.reservedDomains.find((r) => name === r || name.endsWith(`.${r}`)) ?? null;
}

function publicDomain(row: any) {
  return {
    id: row.id,
    name: row.name,
    sender_id: row.sender_id,
    status: row.status,
    checks: { dkim: row.dkim_status, mail_from: row.mail_from_status, dmarc: row.dmarc_status },
    mail_from_domain: row.mail_from_domain,
    dmarc_record: row.dmarc_record,
    records: row.records,
    last_checked_at: row.last_checked_at,
    verified_at: row.verified_at,
    created_at: row.created_at,
  };
}
export { publicDomain };

export async function addDomain(accountId: string, senderId: string | null, rawName: string) {
  const name = rawName.trim().toLowerCase().replace(/\.$/, '');
  if (!DOMAIN_RE.test(name)) throw new ApiError(400, 'invalid_domain', 'שם הדומיין לא תקין');
  if (FREEMAIL_DOMAINS.has(name)) throw new ApiError(400, 'freemail_domain', 'אי אפשר לאמת דומיין של ספק דואר חינמי. צריך דומיין בבעלותך');
  const reserved = reservedParent(name);
  if (reserved === name) {
    throw new ApiError(403, 'reserved_domain', 'הדומיין הזה מנוהל מחוץ למערכת ואי אפשר להוסיף אותו כאן');
  }
  if (reserved) {
    const acc = await one<{ can_use_reserved_domains: boolean }>('SELECT can_use_reserved_domains FROM accounts WHERE id = $1', [accountId]);
    if (!acc?.can_use_reserved_domains) throw new ApiError(403, 'reserved_domain', `אין הרשאה להוסיף תת-דומיין של ${reserved}`);
  }
  const existing = await one('SELECT account_id FROM domains WHERE name = $1', [name]);
  if (existing) throw new ApiError(409, 'domain_taken', 'הדומיין כבר רשום במערכת');

  const provider = getProvider();
  let setup;
  try {
    setup = await provider.createDomain(name);
  } catch (err) {
    if (err instanceof ProviderError && err.code === 'identity_exists') {
      throw new ApiError(409, 'domain_exists_in_provider', 'הדומיין כבר מוגדר בחשבון ה-AWS על ידי מערכת אחרת, ולכן אי אפשר להוסיף אותו כאן');
    }
    throw err;
  }
  const dmarc = await findDmarcRecord(name);
  const records: DnsRecord[] = setup.records.map((r) => ({ ...r, status: 'pending' }));
  // An existing record on a parent domain already covers this one: show where it is, and never suggest a second record.
  records.push({
    type: 'TXT',
    name: dmarc?.name ?? `_dmarc.${name}`,
    value: dmarc?.value ?? SUGGESTED_DMARC,
    purpose: 'dmarc',
    status: dmarc ? 'verified' : 'pending',
  });
  const row = await one(
    `INSERT INTO domains (account_id, sender_id, name, provider, provider_data, mail_from_domain, records, dmarc_status, dmarc_record)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [accountId, senderId, name, provider.name, JSON.stringify(setup.providerData ?? {}), setup.mailFromDomain, JSON.stringify(records), dmarc ? 'verified' : 'pending', dmarc?.value ?? null],
  );
  return checkDomain(row);
}

/** Re-checks a domain at the provider and in DNS, updates its status and emits webhook events. */
export async function checkDomain(row: any) {
  const provider = getProvider(row.provider);
  let status = { dkim: 'pending', mailFrom: 'pending' } as { dkim: string; mailFrom: string };
  try {
    status = await provider.getDomainStatus(row.name, row.provider_data ?? {});
  } catch (err) {
    console.error(`domain check failed for ${row.name}`, err);
  }
  const dmarcRec = await findDmarcRecord(row.name);
  const dmarc = dmarcRec?.value ?? null;
  const dmarcStatus = dmarc ? 'verified' : 'pending';
  const all = status.dkim === 'verified' && status.mailFrom === 'verified' && dmarcStatus === 'verified';

  let next: string = row.status;
  if (all) next = 'verified';
  else if (row.status === 'verified' || row.status === 'degraded') next = 'degraded';
  else if (Date.now() - new Date(row.created_at).getTime() > VERIFY_WINDOW_HOURS * 3600_000) next = 'failed';
  else next = 'pending';

  const bimiRec = (row.records as DnsRecord[]).find((r) => r.purpose === 'bimi');
  let bimiDns = 'pending';
  if (bimiRec) {
    const found = await txt(bimiRec.name);
    const want = bimiRec.value.match(/l=([^;\s]+)/)?.[1];
    bimiDns = found.some((t) => /v=BIMI1/i.test(t) && (!want || t.includes(want))) ? 'verified' : 'pending';
  }
  const byPurpose: Record<string, string> = {
    bimi: bimiDns,
    dkim: status.dkim,
    mail_from_mx: status.mailFrom,
    mail_from_spf: status.mailFrom,
    dmarc: dmarcStatus,
  };
  const records = (row.records as DnsRecord[]).map((r) => ({
    ...r,
    // Domains created before the regional DKIM fix stored the global target: correct it in place.
    ...(row.provider === 'ses' && r.purpose === 'dkim'
      ? { value: r.value.replace(/\.dkim\.(?:[a-z0-9-]+\.)?amazonses\.com$/, `.${dkimDomain()}`) }
      : {}),
    ...(r.purpose === 'dmarc' && dmarcRec ? { name: dmarcRec.name, value: dmarcRec.value } : {}),
    status: byPurpose[r.purpose] ?? r.status,
  }));

  const updated = await one(
    `UPDATE domains SET status = $2, dkim_status = $3, mail_from_status = $4, dmarc_status = $5, dmarc_record = $6,
       records = $7, last_checked_at = now(), verified_at = CASE WHEN $2 = 'verified' THEN coalesce(verified_at, now()) ELSE verified_at END
     WHERE id = $1 RETURNING *`,
    [row.id, next, status.dkim, status.mailFrom, dmarcStatus, dmarc, JSON.stringify(records)],
  );

  if (next !== row.status && ['verified', 'failed', 'degraded'].includes(next)) {
    await emitEvent(row.account_id, `domain.${next}`, { domain: publicDomain(updated) });
  }
  return publicDomain(updated);
}

export async function deleteDomain(row: any) {
  // Never delete a provider identity that this system does not own (shared AWS account).
  if (reservedParent(row.name) !== row.name && !row.provider_data?.external) {
    await getProvider(row.provider).deleteDomain(row.name, row.provider_data ?? {});
  }
  await query('DELETE FROM domains WHERE id = $1', [row.id]);
}

/** Domains due for a check: pending ones every 10 minutes during the window, verified ones daily. */
export async function checkDueDomains() {
  const due = await query(
    `SELECT * FROM domains WHERE
       (status = 'pending' AND (last_checked_at IS NULL OR last_checked_at < now() - interval '10 minutes'))
       OR (status IN ('verified', 'degraded') AND (last_checked_at IS NULL OR last_checked_at < now() - interval '1 day'))
     ORDER BY last_checked_at NULLS FIRST LIMIT 20`,
  );
  for (const row of due) await checkDomain(row);
  return due.length;
}

/**
 * Finds the verified domain that may send as `email` for this account / sender.
 * A subdomain of a verified domain also passes (DMARC relaxed alignment).
 */
export async function findSendingDomain(accountId: string, senderId: string | null, email: string) {
  const d = domainOf(email);
  const candidates = d.split('.').map((_, i, a) => a.slice(i).join('.')).filter((x) => x.includes('.'));
  const rows = await query(
    `SELECT * FROM domains WHERE account_id = $1 AND sender_id IS NOT DISTINCT FROM $2 AND name = ANY($3) AND status = 'verified'
     ORDER BY length(name) DESC LIMIT 1`,
    [accountId, senderId, candidates],
  );
  return rows[0] ?? null;
}

/** Is this address on a domain registered to someone else? */
export async function domainOwnedElsewhere(accountId: string, senderId: string | null, email: string) {
  const d = domainOf(email);
  const candidates = d.split('.').map((_, i, a) => a.slice(i).join('.')).filter((x) => x.includes('.'));
  const row = await one(
    `SELECT 1 FROM domains WHERE name = ANY($3) AND NOT (account_id = $1 AND sender_id IS NOT DISTINCT FROM $2) LIMIT 1`,
    [accountId, senderId, candidates],
  );
  return !!row;
}

function zoneTxt(value: string) {
  // TXT strings are limited to 255 characters: long values (e.g. a DKIM key) are split into several quoted parts.
  const parts = value.match(/.{1,255}/g) ?? [''];
  return parts.map((p) => `"${p.replace(/(["\\])/g, '\\$1')}"`).join(' ');
}

/**
 * BIND zone file with the records a customer still needs, ready for "Import" in Cloudflare
 * (or any DNS host that accepts zone files). An existing DMARC record is never repeated.
 */
export function zoneFile(row: any): string {
  const records = (row.records as DnsRecord[]).filter((r) => !(r.purpose === 'dmarc' && r.status === 'verified'));
  const lines = [
    `;; DNS records for sending email from ${row.name}`,
    `;; Generated ${new Date().toISOString()}. Import into the DNS zone of ${row.name} (or its parent domain).`,
    `;; All records must be "DNS only" (not proxied).`,
  ];
  for (const r of records) {
    const name = `${r.name.replace(/\.$/, '')}.`;
    const tag = ' ; cf_tags=cf-proxied:false';
    if (r.type === 'CNAME') lines.push(`${name}\t3600\tIN\tCNAME\t${r.value.replace(/\.$/, '')}.${tag}`);
    else if (r.type === 'MX') lines.push(`${name}\t3600\tIN\tMX\t${r.priority ?? 10} ${r.value.replace(/\.$/, '')}.`);
    else if (r.type === 'TXT') lines.push(`${name}\t3600\tIN\tTXT\t${zoneTxt(r.value)}`);
  }
  return `${lines.join('\n')}\n`;
}
