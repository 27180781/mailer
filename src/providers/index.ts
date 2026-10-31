import { config } from '../config.js';
import type { EmailProvider } from './types.js';
import { SesProvider } from './ses.js';
import { SmtpProvider } from './smtp.js';
import { LogProvider } from './log.js';

const providers = new Map<string, EmailProvider>();

/** Returns a provider by name; the default comes from EMAIL_PROVIDER. */
export function getProvider(name: string = config.provider): EmailProvider {
  let p = providers.get(name);
  if (!p) {
    if (name === 'ses') p = new SesProvider();
    else if (name === 'smtp') p = new SmtpProvider();
    else if (name === 'log') p = new LogProvider();
    else throw new Error(`ספק שליחה לא מוכר: ${name}`);
    providers.set(name, p);
  }
  return p;
}

export * from './types.js';
