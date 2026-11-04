/**
 * Provider abstraction. The rest of the system only knows this interface,
 * so Amazon SES can be swapped for another provider without touching business logic.
 */

export type DnsRecordPurpose = 'dkim' | 'mail_from_mx' | 'mail_from_spf' | 'dmarc' | 'bimi';

export interface DnsRecord {
  type: 'CNAME' | 'TXT' | 'MX';
  name: string;
  value: string;
  priority?: number;
  purpose: DnsRecordPurpose;
  status?: 'pending' | 'verified' | 'failed';
}

export interface DomainSetup {
  records: DnsRecord[];
  mailFromDomain: string;
  /** Opaque data the provider needs later (e.g. a DKIM private key). Stored in domains.provider_data. */
  providerData?: Record<string, unknown>;
}

export type CheckStatus = 'pending' | 'verified' | 'failed';

export interface DomainStatus {
  dkim: CheckStatus;
  mailFrom: CheckStatus;
}

export interface OutgoingEmail {
  /** Our message id, used for correlation */
  id: string;
  from: string;
  /** Primary recipient (first To) */
  to: string;
  /** Every envelope recipient: To, Cc and Bcc. Bcc never appears in the headers. */
  recipients: string[];
  /** Complete RFC 5322 message, already built by the system */
  raw: Buffer;
  domain: string;
  providerData?: Record<string, unknown>;
  tags?: Record<string, string>;
}

export type ProviderEventType = 'delivered' | 'bounced' | 'complained' | 'rejected' | 'delayed';

export interface ProviderEvent {
  type: ProviderEventType;
  providerMessageId: string;
  recipient: string;
  bounceType?: 'hard' | 'soft';
  detail?: string;
  occurredAt: Date;
  raw?: unknown;
}

export class ProviderError extends Error {
  constructor(message: string, public readonly temporary: boolean, public readonly code?: string) {
    super(message);
  }
}

export interface EmailProvider {
  readonly name: string;
  send(email: OutgoingEmail): Promise<{ providerMessageId: string }>;
  createDomain(domain: string): Promise<DomainSetup>;
  getDomainStatus(domain: string, providerData: Record<string, unknown>): Promise<DomainStatus>;
  deleteDomain(domain: string, providerData: Record<string, unknown>): Promise<void>;
  /** Translate a provider webhook into normalized events. Must verify authenticity. */
  parseWebhook(headers: Record<string, string | string[] | undefined>, body: string): Promise<ProviderEvent[]>;
}
