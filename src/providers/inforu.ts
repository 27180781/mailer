/**
 * InforUMobile email API (Umail). Unlike SES it is a campaign service: one HTML body goes to a list of contacts,
 * and InforU itself sends, tracks and handles its own unsubscribe link. Used only for campaigns whose account
 * connected InforU and chose it as the channel. Based on the working client in the Stamp Mailer project.
 */
export const INFORU_BASE = (process.env.INFORU_API_BASE || 'https://capi.inforu.co.il/api/v2').replace(/\/$/, '');
/** InforU rejects more than 5,000 records per call (-2011); stay well below */
export const INFORU_BATCH = 1000;

/** Replaceable in tests */
export const inforuHttp = { fetch: (url: string, init?: RequestInit) => fetch(url, init) };

export interface InforuCredentials { username: string; token: string }

const STATUS: Record<number, string> = {
  [-1]: 'כשל כללי בבקשה',
  [-2]: 'האימות מול InforU נכשל: שם המשתמש או הטוקן שגויים, או שכתובת ה-IP של השרת לא נמצאת ברשימת ההיתר של InforU',
  [-221]: 'המשתמש ב-InforU אינו פעיל',
  [-222]: 'החשבון ב-InforU נעול',
  [-2010]: 'InforU: מקסימום 100 רשומות לפעולה זו',
  [-2011]: 'InforU: מקסימום 5,000 רשומות לפעולה זו',
  [-2015]: 'InforU: פעולה קודמת עדיין בביצוע',
};
/** Errors that retrying will not fix: the campaign is paused with the message */
const FATAL = new Set([-2, -221, -222]);

export class InforuError extends Error {
  constructor(public statusId: number, description: string, detail: string) {
    super([STATUS[statusId] ?? `שגיאה מ-InforU (StatusId ${statusId})`, description, detail].filter(Boolean).join(' | '));
  }
  get fatal() { return FATAL.has(this.statusId); }
}

export async function inforuCall(creds: InforuCredentials, fn: string, data: Record<string, unknown>) {
  const res = await inforuHttp.fetch(`${INFORU_BASE}/${fn}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Basic ${Buffer.from(`${creds.username}:${creds.token}`).toString('base64')}`,
    },
    body: JSON.stringify({ Data: data }),
    signal: AbortSignal.timeout(60_000),
  });
  const raw = await res.text();
  let json: any;
  try { json = JSON.parse(raw); } catch {
    throw new Error(`InforU החזיר תשובה שאינה JSON (HTTP ${res.status}): ${raw.slice(0, 200)}`);
  }
  if (json.StatusId !== 1) throw new InforuError(Number(json.StatusId), json.StatusDescription ?? '', json.DetailedDescription ?? '');
  // Umail/Message/Send answers with CampaignId and token at the top level, other functions inside Data
  return { data: json.Data, requestId: String(json.RequestId ?? ''), raw: json };
}

/** Checks the credentials (lists the contact groups, which sends nothing) */
export async function inforuVerify(creds: InforuCredentials) {
  return { groups: (await inforuGroups(creds)).length };
}

export interface InforuGroup { id: number; number: number; name: string; recipients: number }
/** The account's contact groups in InforU, with how many can receive email */
export async function inforuGroups(creds: InforuCredentials): Promise<InforuGroup[]> {
  const { data } = await inforuCall(creds, 'Contact/GetGroupList', {});
  return (data?.List ?? []).map((g: any) => ({
    id: Number(g.GroupId),
    number: Number(g.GroupNumber),
    name: String(g.GroupName ?? ''),
    recipients: Number(g.CountNonBlockedContactsInfoMail ?? g.CountActiveContactsMail ?? 0),
  }));
}

const compact = (o: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length)));

export interface InforuSend {
  campaignName: string;
  campaignRefId: string;
  fromAddress: string;
  fromName: string;
  replyAddress?: string | null;
  subject: string;
  html: string;
  contacts: { email: string; firstName?: string | null; lastName?: string | null }[];
  /** InforU contact groups to send to as well (by GroupId) */
  groupIds?: number[];
  allowDuplicates?: boolean;
}

export async function inforuSend(creds: InforuCredentials, s: InforuSend) {
  const r = await inforuCall(
    creds,
    'Umail/Message/Send',
    compact({
      CampaignName: s.campaignName.slice(0, 200),
      CampaignRefId: s.campaignRefId,
      FromAddress: s.fromAddress,
      FromName: s.fromName,
      ReplyAddress: s.replyAddress,
      Subject: s.subject,
      Body: s.html,
      AllowDuplicates: s.allowDuplicates,
      IncludeGroupIds: s.groupIds,
      IncludeContacts: s.contacts.map((c) => compact({ Email: c.email, FirstName: c.firstName, LastName: c.lastName })),
    }),
  );
  const campaignId = Number(r.raw.CampaignId ?? r.data?.CampaignId ?? 0) || null;
  return { campaignId, token: String(r.raw.token ?? r.data?.token ?? ''), requestId: r.requestId };
}

export interface InforuCampaignStats { id: number; status: string; sent: number; opened: number; clicks: number; returned: number; blocked: number }
/** Totals per InforU campaign (Umail/Campaign/List) */
export async function inforuCampaignStats(creds: InforuCredentials, ids: number[]): Promise<InforuCampaignStats[]> {
  if (!ids.length) return [];
  const { data } = await inforuCall(creds, 'Umail/Campaign/List', { CampaignIds: ids.map(String) });
  return (data?.List ?? []).map((c: any) => ({
    id: Number(c.id), status: String(c.status ?? ''), sent: Number(c.sent) || 0, opened: Number(c.opened) || 0,
    clicks: Number(c.clicks) || 0, returned: Number(c.returned) || 0, blocked: Number(c.blocked) || 0,
  }));
}

export interface InforuMailEvent { Datetime: string; CampaignId: number; Email: string; Action: string; Value?: string; MoreInfo?: string; AdditionalInformation?: string }
/** Per-recipient events (delivery, open, click, return, unsubscribe). Pulled items leave InforU's queue. Needs InforU to enable it. */
export async function inforuMailNotifications(creds: InforuCredentials, batchSize = 500): Promise<InforuMailEvent[]> {
  const { data } = await inforuCall(creds, 'Umail/GetMailNotification', { BatchSize: String(batchSize) });
  return data?.List ?? [];
}

/** Email addresses that unsubscribed in InforU, from LastFetchedId on */
export async function inforuUnsubscribes(creds: InforuCredentials, fromDate: string, toDate: string, lastFetchedId: number | null) {
  const { data } = await inforuCall(creds, 'Contact/GetUnsubscribeList', { FromDate: fromDate, ToDate: toDate, Type: 'Email', LastFetchedId: lastFetchedId ?? 0 });
  return { lastFetchedId: Number(data?.LastFetchedId ?? lastFetchedId ?? 0) || null, list: (data?.List ?? []) as { Value: string; UnsubscribeDatetime: string }[] };
}

/** Remaining email packages (Newsletters) at customer level */
export async function inforuEmailQuota(creds: InforuCredentials): Promise<{ remaining: number; warning: number } | null> {
  const { data } = await inforuCall(creds, 'Admin/GetQuota', { QuotaUsageType: '' });
  const q = (data?.List ?? []).find((x: any) => /newsletter|email|mail/i.test(String(x.QuotaUsageType)));
  return q ? { remaining: Number(q.RemainingQuota) || 0, warning: Number(q.WarningLevel) || 0 } : null;
}
