import nodemailer from 'nodemailer';
import { generateKeyPairSync } from 'node:crypto';
import { resolveMx, resolveTxt } from 'node:dns/promises';
import { config } from '../config.js';
import type { DomainSetup, DomainStatus, EmailProvider, OutgoingEmail, ProviderEvent } from './types.js';
import { ProviderError } from './types.js';

const SELECTOR = 'mk1';

async function txt(name: string): Promise<string[]> {
  try {
    return (await resolveTxt(name)).map((parts) => parts.join(''));
  } catch {
    return [];
  }
}

/**
 * Generic SMTP provider. Signs DKIM itself with a per-domain key, so any SMTP relay works.
 * Bounces and complaints must be handled by the relay; there is no webhook here.
 */
export class SmtpProvider implements EmailProvider {
  readonly name = 'smtp';
  private transport = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  });

  async send(email: OutgoingEmail) {
    const privateKey = email.providerData?.dkimPrivateKey as string | undefined;
    try {
      const info = await this.transport.sendMail({
        envelope: { from: `bounce@${config.ses.mailFromSubdomain}.${email.domain}`, to: email.recipients },
        raw: email.raw,
        dkim: privateKey ? { domainName: email.domain, keySelector: SELECTOR, privateKey } : undefined,
      } as any);
      return { providerMessageId: info.messageId || email.id };
    } catch (err: any) {
      const code = Number(err?.responseCode);
      throw new ProviderError(err?.message ?? String(err), !code || code < 500, String(code || err?.code || ''));
    }
  }

  async createDomain(domain: string): Promise<DomainSetup> {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const mailFromDomain = `${config.ses.mailFromSubdomain}.${domain}`;
    const records: DomainSetup['records'] = [
      { type: 'TXT', name: `${SELECTOR}._domainkey.${domain}`, value: `v=DKIM1; k=rsa; p=${pub}`, purpose: 'dkim' },
    ];
    if (config.smtp.returnPathHost) records.push({ type: 'MX', name: mailFromDomain, value: config.smtp.returnPathHost, priority: 10, purpose: 'mail_from_mx' });
    if (config.smtp.spfInclude) records.push({ type: 'TXT', name: mailFromDomain, value: `v=spf1 include:${config.smtp.spfInclude} ~all`, purpose: 'mail_from_spf' });
    return {
      mailFromDomain,
      records,
      providerData: { dkimPrivateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), dkimPublicKey: pub },
    };
  }

  async getDomainStatus(domain: string, providerData: Record<string, unknown>): Promise<DomainStatus> {
    const dkimTxt = await txt(`${SELECTOR}._domainkey.${domain}`);
    const dkim = dkimTxt.some((t) => t.replace(/\s/g, '').includes(`p=${providerData.dkimPublicKey}`)) ? 'verified' : 'pending';
    let mailFrom: DomainStatus['mailFrom'] = 'verified';
    if (config.smtp.returnPathHost) {
      const name = `${config.ses.mailFromSubdomain}.${domain}`;
      const mx = await resolveMx(name).catch(() => []);
      const spf = await txt(name);
      mailFrom = mx.some((m) => m.exchange === config.smtp.returnPathHost) && spf.some((t) => t.startsWith('v=spf1')) ? 'verified' : 'pending';
    }
    return { dkim, mailFrom };
  }

  async deleteDomain() {}

  async parseWebhook(): Promise<ProviderEvent[]> {
    return [];
  }
}
