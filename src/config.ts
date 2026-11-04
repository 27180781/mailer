function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`חסר משתנה סביבה: ${name}`);
  return v;
}

export const config = {
  appName: env('APP_NAME', 'דיוור'),
  port: Number(env('PORT', '3000')),
  role: env('ROLE', 'all') as 'web' | 'worker' | 'all',
  databaseUrl: env('DATABASE_URL', 'postgres://postgres:postgres@localhost:5432/mailer'),
  // Public base URL used in unsubscribe and tracking links, e.g. https://mail.example.co.il
  publicUrl: env('PUBLIC_URL', 'http://localhost:3000').replace(/\/$/, ''),
  // Secret used to sign unsubscribe / tracking links. Must be long and random in production.
  appSecret: env('APP_SECRET', 'dev-secret-change-me'),
  provider: env('EMAIL_PROVIDER', 'ses') as 'ses' | 'smtp' | 'log',
  ses: {
    region: env('SES_REGION', 'eu-central-1'),
    configurationSet: process.env.SES_CONFIGURATION_SET || undefined,
    mailFromSubdomain: env('MAIL_FROM_SUBDOMAIN', 'bounce'),
  },
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT || '587'),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    secure: process.env.SMTP_SECURE === 'true',
    // Host that receives bounces for the custom MAIL FROM domain when using generic SMTP
    returnPathHost: process.env.SMTP_RETURN_PATH_HOST || '',
    spfInclude: process.env.SMTP_SPF_INCLUDE || '',
  },
  // Global ceiling on emails per second across all accounts (provider quota)
  maxSendRate: Number(env('MAX_SEND_RATE', '14')),
  // System-wide cap on emails sent in any rolling 24 hours (0 = no cap). Keep it below the SES
  // daily quota when the AWS account is shared with another system (e.g. Retzef).
  dailySendCap: Number(env('DAILY_SEND_CAP', '0')),
  newAccountDailyLimit: Number(env('NEW_ACCOUNT_DAILY_LIMIT', '200')),
  apiRateLimitPerMinute: Number(env('API_RATE_LIMIT_PER_MINUTE', '600')),
  // Domains whose SES identity is managed outside this system (same AWS account), e.g. retsef.co.il.
  // Nobody may add or delete them here; subdomains only for accounts with can_use_reserved_domains.
  reservedDomains: (process.env.RESERVED_DOMAINS || '').split(',').map((s) => s.trim().toLowerCase().replace(/\.$/, '')).filter(Boolean),
  // Operator's own Cloudflare token (Zone · DNS · Edit). Used only for super admin accounts and
  // accounts allowed to use reserved domains, never for regular customers.
  cloudflareToken: process.env.CLOUDFLARE_API_TOKEN || '',
  // Comma separated emails that become super admins on signup
  superAdmins: (process.env.SUPER_ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
};
