import {
  SESv2Client,
  CreateEmailIdentityCommand,
  GetEmailIdentityCommand,
  DeleteEmailIdentityCommand,
  PutEmailIdentityMailFromAttributesCommand,
  SendEmailCommand,
} from '@aws-sdk/client-sesv2';
import { createVerify, X509Certificate } from 'node:crypto';
import { config } from '../config.js';
import type { CheckStatus, DomainSetup, DomainStatus, EmailProvider, OutgoingEmail, ProviderEvent } from './types.js';
import { ProviderError } from './types.js';

const TEMPORARY_ERRORS = new Set([
  'TooManyRequestsException',
  'LimitExceededException',
  'ThrottlingException',
  'SendingPausedException',
  'AccountSuspendedException',
  'InternalFailure',
  'ServiceUnavailable',
  'InternalServerError',
]);

function mapStatus(s: string | undefined): CheckStatus {
  if (s === 'SUCCESS') return 'verified';
  if (s === 'FAILED') return 'failed';
  return 'pending';
}

// Regions launched before 2020 use the global DKIM domain; newer ones (e.g. il-central-1) use a regional one.
const GLOBAL_DKIM_REGIONS = new Set([
  'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2', 'ca-central-1', 'sa-east-1',
  'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-central-1', 'eu-north-1',
  'ap-south-1', 'ap-northeast-1', 'ap-northeast-2', 'ap-southeast-1', 'ap-southeast-2',
  'us-gov-west-1',
]);

/** Domain that Easy DKIM CNAME records point to, e.g. dkim.il-central-1.amazonses.com. SES_DKIM_DOMAIN overrides. */
export function dkimDomain(region = config.ses.region): string {
  if (process.env.SES_DKIM_DOMAIN) return process.env.SES_DKIM_DOMAIN;
  return GLOBAL_DKIM_REGIONS.has(region) ? 'dkim.amazonses.com' : `dkim.${region}.amazonses.com`;
}

const SNS_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;
const certCache = new Map<string, string>();

async function fetchCert(url: string): Promise<string> {
  const u = new URL(url);
  if (u.protocol !== 'https:' || !SNS_HOST.test(u.hostname)) throw new Error('כתובת תעודת SNS לא חוקית');
  const cached = certCache.get(url);
  if (cached) return cached;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`הורדת תעודת SNS נכשלה: ${res.status}`);
  const pem = await res.text();
  new X509Certificate(pem); // throws if not a certificate
  certCache.set(url, pem);
  return pem;
}

export async function verifySnsMessage(msg: Record<string, string>): Promise<boolean> {
  const fields =
    msg.Type === 'Notification'
      ? ['Message', 'MessageId', ...(msg.Subject !== undefined ? ['Subject'] : []), 'Timestamp', 'TopicArn', 'Type']
      : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];
  const stringToSign = fields.map((f) => `${f}\n${msg[f]}\n`).join('');
  const algorithm = msg.SignatureVersion === '2' ? 'RSA-SHA256' : 'RSA-SHA1';
  const pem = await fetchCert(msg.SigningCertURL);
  const verifier = createVerify(algorithm);
  verifier.update(stringToSign, 'utf8');
  return verifier.verify(pem, msg.Signature, 'base64');
}

export class SesProvider implements EmailProvider {
  readonly name = 'ses';
  private client = new SESv2Client({ region: config.ses.region });

  async send(email: OutgoingEmail) {
    try {
      const out = await this.client.send(
        new SendEmailCommand({
          // No FromEmailAddress: with raw content SES would put the bare address in the From header and drop
          // the display name. SES reads the sender (and checks the identity) from the From header we built.
          Destination: { ToAddresses: email.recipients },
          Content: { Raw: { Data: email.raw } },
          ConfigurationSetName: config.ses.configurationSet,
          EmailTags: Object.entries(email.tags ?? {}).map(([Name, Value]) => ({
            Name,
            Value: Value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 256),
          })),
        }),
      );
      return { providerMessageId: out.MessageId! };
    } catch (err: any) {
      const name = err?.name ?? 'Error';
      const temporary = TEMPORARY_ERRORS.has(name) || err?.$retryable !== undefined || !err?.$metadata;
      throw new ProviderError(`${name}: ${err?.message ?? err}`, temporary, name);
    }
  }

  async createDomain(domain: string): Promise<DomainSetup> {
    let out;
    try {
      out = await this.client.send(
        new CreateEmailIdentityCommand({
          EmailIdentity: domain,
          DkimSigningAttributes: { NextSigningKeyLength: 'RSA_2048_BIT' },
          ConfigurationSetName: config.ses.configurationSet,
        }),
      );
    } catch (err: any) {
      // The AWS account is shared: an identity that already exists belongs to another system. Never adopt it.
      if (err?.name === 'AlreadyExistsException') {
        throw new ProviderError(`identity ${domain} already exists in the SES account`, false, 'identity_exists');
      }
      throw err;
    }
    const mailFromDomain = `${config.ses.mailFromSubdomain}.${domain}`;
    await this.client.send(
      new PutEmailIdentityMailFromAttributesCommand({
        EmailIdentity: domain,
        MailFromDomain: mailFromDomain,
        BehaviorOnMxFailure: 'USE_DEFAULT_VALUE',
      }),
    );
    const tokens = out.DkimAttributes?.Tokens ?? [];
    return {
      mailFromDomain,
      records: [
        ...tokens.map((t) => ({
          type: 'CNAME' as const,
          name: `${t}._domainkey.${domain}`,
          value: `${t}.${dkimDomain()}`,
          purpose: 'dkim' as const,
        })),
        {
          type: 'MX',
          name: mailFromDomain,
          value: `feedback-smtp.${config.ses.region}.amazonses.com`,
          priority: 10,
          purpose: 'mail_from_mx',
        },
        { type: 'TXT', name: mailFromDomain, value: 'v=spf1 include:amazonses.com ~all', purpose: 'mail_from_spf' },
      ],
    };
  }

  async getDomainStatus(domain: string): Promise<DomainStatus> {
    const out = await this.client.send(new GetEmailIdentityCommand({ EmailIdentity: domain }));
    return {
      dkim: mapStatus(out.DkimAttributes?.Status),
      mailFrom: mapStatus(out.MailFromAttributes?.MailFromDomainStatus),
    };
  }

  async deleteDomain(domain: string) {
    try {
      await this.client.send(new DeleteEmailIdentityCommand({ EmailIdentity: domain }));
    } catch (err: any) {
      if (err?.name !== 'NotFoundException') throw err;
    }
  }

  async parseWebhook(_headers: Record<string, unknown>, body: string): Promise<ProviderEvent[]> {
    const msg = JSON.parse(body) as Record<string, string>;
    if (!(await verifySnsMessage(msg))) throw new Error('חתימת SNS לא תקינה');
    const allowedTopic = process.env.SES_SNS_TOPIC_ARN;
    if (allowedTopic && msg.TopicArn !== allowedTopic) throw new Error('נושא SNS לא מורשה');

    if (msg.Type === 'SubscriptionConfirmation') {
      const u = new URL(msg.SubscribeURL);
      if (u.protocol === 'https:' && SNS_HOST.test(u.hostname)) await fetch(u);
      return [];
    }
    if (msg.Type !== 'Notification') return [];

    const n = JSON.parse(msg.Message);
    const type: string = n.eventType ?? n.notificationType;
    const messageId: string = n.mail?.messageId;
    const events: ProviderEvent[] = [];
    const at = (ts?: string) => (ts ? new Date(ts) : new Date());

    if (type === 'Delivery') {
      for (const r of n.delivery?.recipients ?? []) events.push({ type: 'delivered', providerMessageId: messageId, recipient: r, occurredAt: at(n.delivery?.timestamp) });
    } else if (type === 'Bounce') {
      const hard = n.bounce?.bounceType === 'Permanent';
      for (const r of n.bounce?.bouncedRecipients ?? [])
        events.push({
          type: 'bounced',
          providerMessageId: messageId,
          recipient: r.emailAddress,
          bounceType: hard ? 'hard' : 'soft',
          detail: r.diagnosticCode ?? n.bounce?.bounceSubType,
          occurredAt: at(n.bounce?.timestamp),
        });
    } else if (type === 'Complaint') {
      for (const r of n.complaint?.complainedRecipients ?? [])
        events.push({ type: 'complained', providerMessageId: messageId, recipient: r.emailAddress, detail: n.complaint?.complaintFeedbackType, occurredAt: at(n.complaint?.timestamp) });
    } else if (type === 'Reject') {
      for (const r of n.mail?.destination ?? []) events.push({ type: 'rejected', providerMessageId: messageId, recipient: r, detail: n.reject?.reason, occurredAt: at() });
    } else if (type === 'DeliveryDelay') {
      for (const r of n.deliveryDelay?.delayedRecipients ?? [])
        events.push({ type: 'delayed', providerMessageId: messageId, recipient: r.emailAddress, detail: n.deliveryDelay?.delayType, occurredAt: at(n.deliveryDelay?.timestamp) });
    }
    return events;
  }
}
