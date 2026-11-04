import { createPrivateKey, createPublicKey, createSign, generateKeyPairSync } from 'node:crypto';
import { config } from '../config.js';
import { one, query } from '../db.js';
import { signToken } from '../crypto.js';
import { dnsLookup } from './domains.js';
import type { DnsRecord } from '../providers/types.js';

/**
 * Domain Connect (https://www.domainconnect.org): the customer clicks one button, approves the
 * records at their DNS provider (Cloudflare, GoDaddy, IONOS…), and comes back verified. No token.
 * Requires our template to be registered with each DNS provider; until then the UI falls back to
 * the API-token flow and the zone file.
 */

export const DC_PROVIDER_ID = 'retsef.co.il';
export const DC_PROVIDER_NAME = 'Retzef Mailer';
export const DC_KEY_HOST = '_dck1';
export const DC_TEMPLATE_VERSION = 1;

/** Replaceable in tests */
export const dcHttp = { fetch: (url: string, init?: RequestInit) => fetch(url, init) };

/**
 * Three templates, so an existing DMARC record is never duplicated and the BIMI logo can be added on its own.
 * Cloudflare ignores TXT conflict modes (a TXT only conflicts with an identical one), so the choice is ours.
 */
export const DC_SERVICES = {
  main: 'mailer',
  keepDmarc: 'mailer-nodmarc',
  bimi: 'mailer-bimi',
} as const;
export const DC_SERVICE_ID = DC_SERVICES.main;
/** The MAIL FROM label is fixed in the templates */
const MAIL_FROM_LABEL = 'bounce';

function baseTemplate(serviceId: string, serviceName: string, description: string, records: object[], variableDescription: string) {
  return {
    providerId: DC_PROVIDER_ID,
    providerName: DC_PROVIDER_NAME,
    serviceId,
    serviceName,
    version: DC_TEMPLATE_VERSION,
    logoUrl: `${config.publicUrl}/app/logo.svg`,
    description,
    variableDescription,
    syncBlock: false,
    sharedProviderName: false,
    syncPubKeyDomain: DC_PROVIDER_ID,
    syncRedirectDomain: new URL(config.publicUrl).hostname,
    hostRequired: false,
    records,
  };
}

/**
 * Only the variable parts are variables (the Domain Connect quality rules): fixed host labels,
 * fixed target domains, and the DMARC/BIMI values built around a small variable.
 */
const SENDING_RECORDS = [
  ...[1, 2, 3].map((i) => ({ type: 'CNAME', host: `%dkim${i}%._domainkey`, pointsTo: `%dkim${i}%.dkim.%region%.amazonses.com`, ttl: 3600 })),
  { type: 'MX', host: MAIL_FROM_LABEL, pointsTo: 'feedback-smtp.%region%.amazonses.com', priority: 10, ttl: 3600 },
  // SPFM merges with an existing SPF record instead of creating a second one (Cloudflare requirement)
  { type: 'SPFM', host: MAIL_FROM_LABEL, spfRules: 'include:amazonses.com' },
];
const SENDING_VARS = 'dkim1, dkim2, dkim3: the Amazon SES Easy DKIM tokens of the domain; region: the Amazon SES region (e.g. il-central-1)';

const DMARC_RECORD = {
  type: 'TXT',
  host: '_dmarc',
  data: 'v=DMARC1; p=%dmarcpolicy%; adkim=r; aspf=r',
  ttl: 3600,
  txtConflictMatchingMode: 'Prefix',
  txtConflictMatchingPrefix: 'v=DMARC1',
  essential: 'OnApply',
};

export function templates() {
  const bimiRecord = {
    type: 'TXT',
    host: 'default._bimi',
    data: `v=BIMI1; l=${config.publicUrl}/bimi/%fqdn%/logo.svg;`,
    ttl: 3600,
    txtConflictMatchingMode: 'Prefix',
    txtConflictMatchingPrefix: 'v=BIMI1',
    essential: 'OnApply',
  };
  return [
    baseTemplate(
      DC_SERVICES.main,
      'Email sending (DKIM, MAIL FROM, DMARC)',
      'Adds the DNS records to send authenticated email through the Retzef mailer (Amazon SES): DKIM, a custom MAIL FROM domain with SPF, and a DMARC policy.',
      [...SENDING_RECORDS, DMARC_RECORD],
      `${SENDING_VARS}; dmarcpolicy: DMARC policy (none, quarantine or reject)`,
    ),
    baseTemplate(
      DC_SERVICES.keepDmarc,
      'Email sending (DKIM, MAIL FROM)',
      'Adds the DNS records to send authenticated email through the Retzef mailer (Amazon SES): DKIM and a custom MAIL FROM domain with SPF. For domains that already publish DMARC.',
      SENDING_RECORDS,
      SENDING_VARS,
    ),
    baseTemplate(
      DC_SERVICES.bimi,
      'Sender logo (BIMI)',
      'Publishes a BIMI record so mailbox providers can show the sender logo hosted by the Retzef mailer.',
      [bimiRecord],
      'No variables: the logo URL is built from the domain name.',
    ),
  ];
}

/** The main template */
export const template = () => templates()[0];

/** The RSA key that signs apply requests. From DOMAIN_CONNECT_PRIVATE_KEY, or generated once and kept in the database. */
export async function signingKey(): Promise<string> {
  if (process.env.DOMAIN_CONNECT_PRIVATE_KEY) return process.env.DOMAIN_CONNECT_PRIVATE_KEY.replace(/\\n/g, '\n');
  const row = await one<{ value: string }>(`SELECT value FROM system_kv WHERE key = 'domain_connect_private_key'`);
  if (row) return row.value;
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  await query(`INSERT INTO system_kv (key, value) VALUES ('domain_connect_private_key', $1) ON CONFLICT (key) DO NOTHING`, [pem]);
  return (await one<{ value: string }>(`SELECT value FROM system_kv WHERE key = 'domain_connect_private_key'`))!.value;
}

/** TXT records that publish the public key at _dck1.retsef.co.il (split into numbered parts). */
export async function publicKeyRecords() {
  const der = createPublicKey(createPrivateKey(await signingKey())).export({ type: 'spki', format: 'der' }).toString('base64');
  const parts = der.match(/.{1,200}/g)!;
  return parts.map((d, i) => ({ type: 'TXT', name: `${DC_KEY_HOST}.${DC_PROVIDER_ID}`, value: `p=${i + 1},a=RS256,d=${d}` }));
}

export async function publicKeyPublished() {
  const want = (await publicKeyRecords()).map((r) => r.value).sort();
  let got: string[] = [];
  try {
    got = (await dnsLookup.resolveTxt(`${DC_KEY_HOST}.${DC_PROVIDER_ID}`)).map((p) => p.join('')).sort();
  } catch {}
  return want.every((w) => got.includes(w));
}

export interface DcSettings { providerId: string; providerName: string; providerDisplayName?: string; urlSyncUX: string; urlAPI: string }

/** Finds the DNS provider of a domain through its _domainconnect record (on the domain or a parent zone). */
export async function discover(domain: string): Promise<{ zone: string; settings: DcSettings } | null> {
  const labels = domain.split('.');
  for (let i = 0; i <= labels.length - 2; i++) {
    const zone = labels.slice(i).join('.');
    let host: string | undefined;
    try {
      host = (await dnsLookup.resolveTxt(`_domainconnect.${zone}`)).map((p) => p.join(''))[0];
    } catch {}
    if (!host) continue;
    try {
      const res = await dcHttp.fetch(`https://${host.replace(/^https?:\/\//, '').replace(/\/$/, '')}/v2/${zone}/settings`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const settings = (await res.json()) as DcSettings;
      if (settings.urlSyncUX && settings.urlAPI) return { zone, settings };
    } catch {}
  }
  return null;
}

const supportCache = new Map<string, { at: number; ok: boolean }>();

/** Does this DNS provider know our template? Cached for an hour. */
export async function templateSupported(settings: DcSettings, serviceId: string = DC_SERVICES.main): Promise<boolean> {
  const key = `${settings.urlAPI}|${serviceId}`;
  const hit = supportCache.get(key);
  if (hit && Date.now() - hit.at < 3_600_000) return hit.ok;
  let ok = false;
  try {
    const res = await dcHttp.fetch(`${settings.urlAPI.replace(/\/$/, '')}/v2/domainTemplates/providers/${DC_PROVIDER_ID}/services/${serviceId}`, { signal: AbortSignal.timeout(8000) });
    ok = res.ok;
  } catch {}
  supportCache.set(key, { at: Date.now(), ok });
  return ok;
}

/** Which template to apply for a domain's still-missing records, with its variables. */
export function applyParams(row: { name: string; records: DnsRecord[] }): { serviceId: string; vars: Record<string, string> } | null {
  const pending = (p: string) => row.records.filter((r) => r.purpose === p && r.status !== 'verified');
  const dkim = row.records.filter((r) => r.purpose === 'dkim');
  const mx = row.records.find((r) => r.purpose === 'mail_from_mx');
  const spf = row.records.find((r) => r.purpose === 'mail_from_spf');
  const sendingPending = pending('dkim').length || pending('mail_from_mx').length || pending('mail_from_spf').length;
  const ownDmarc = pending('dmarc').find((r) => r.name === `_dmarc.${row.name}`);

  const region = dkim[0]?.value.match(/^[^.]+\.dkim\.([a-z0-9-]+)\.amazonses\.com\.?$/)?.[1];
  const policy = ownDmarc?.value.match(/^v=DMARC1;.*\bp=(none|quarantine|reject)\b/i)?.[1].toLowerCase();
  const fits =
    dkim.length === 3 &&
    dkim.every((r) => r.type === 'CNAME' && r.value.replace(/\.$/, '').endsWith(`.dkim.${region}.amazonses.com`)) &&
    mx?.name === `${MAIL_FROM_LABEL}.${row.name}` &&
    mx.value.replace(/\.$/, '') === `feedback-smtp.${region}.amazonses.com` &&
    spf?.name === mx.name &&
    (!ownDmarc || !!policy);

  if (sendingPending && region && fits) {
    const vars: Record<string, string> = { region };
    dkim.forEach((r, i) => {
      vars[`dkim${i + 1}`] = r.name.split('._domainkey.')[0];
    });
    if (ownDmarc) vars.dmarcpolicy = policy!;
    return { serviceId: ownDmarc ? DC_SERVICES.main : DC_SERVICES.keepDmarc, vars };
  }
  // The template publishes the logo without a certificate (a=); with a VMC the record is added by hand
  const bimi = pending('bimi')[0];
  if (bimi && !/\ba=[^;\s]/.test(bimi.value) && bimi.name === `default._bimi.${row.name}`) return { serviceId: DC_SERVICES.bimi, vars: {} };
  return null;
}

/** Builds the signed "apply" URL that sends the customer to their DNS provider to approve the records. */
export async function applyUrl(row: { id: string; name: string; records: DnsRecord[] }, zone: string, settings: DcSettings) {
  const plan = applyParams(row);
  if (!plan) return null;
  const { serviceId, vars } = plan;
  const host = row.name === zone ? '' : row.name.slice(0, -(zone.length + 1));
  const params = new URLSearchParams();
  params.set('domain', zone);
  if (host) params.set('host', host);
  for (const [k, v] of Object.entries(vars)) params.set(k, v);
  params.set('redirect_uri', `${config.publicUrl}/dc/callback`);
  params.set('state', signToken(row.id));
  const qs = params.toString();
  const signer = createSign('RSA-SHA256');
  signer.update(qs);
  const sig = signer.sign(await signingKey(), 'base64');
  const base = `${settings.urlSyncUX.replace(/\/$/, '')}/v2/domainTemplates/providers/${DC_PROVIDER_ID}/services/${serviceId}/apply`;
  return `${base}?${qs}&key=${DC_KEY_HOST}&sig=${encodeURIComponent(sig)}`;
}
