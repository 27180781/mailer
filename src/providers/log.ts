import type { DomainSetup, EmailProvider, OutgoingEmail, ProviderEvent } from './types.js';

/** Development / test provider: sends nothing, every domain verifies at once. */
export class LogProvider implements EmailProvider {
  readonly name = 'log';
  readonly sent: OutgoingEmail[] = [];

  async send(email: OutgoingEmail) {
    this.sent.push(email);
    if (process.env.LOG_PROVIDER_VERBOSE) console.log(`[log-provider] ${email.from} -> ${email.to}\n${email.raw.toString()}`);
    return { providerMessageId: `log-${email.id}` };
  }
  async createDomain(domain: string): Promise<DomainSetup> {
    return {
      mailFromDomain: `bounce.${domain}`,
      records: [{ type: 'CNAME', name: `test._domainkey.${domain}`, value: 'test.dkim.example.com', purpose: 'dkim' }],
    };
  }
  async getDomainStatus() {
    return { dkim: 'verified' as const, mailFrom: 'verified' as const };
  }
  async deleteDomain() {}
  async parseWebhook(_h: unknown, body: string): Promise<ProviderEvent[]> {
    const events = JSON.parse(body) as ProviderEvent[];
    return events.map((e) => ({ ...e, occurredAt: new Date(e.occurredAt ?? Date.now()) }));
  }
}
