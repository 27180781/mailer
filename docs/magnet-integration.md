# מעבר מגנט ADS ממערכת Resend למערכת הדיוור

המסמך מיועד לצוות הפיתוח של מגנט. הוא מפרט את כל מה שצריך כדי להעביר את המיילים היוצאים של מגנט (CRM, מייל פתיחה, מערכת הערוצים, העברת לידים) מ-Resend למערכת הדיוור, שרצה על Amazon SES.

- **כתובת המערכת:** https://mail.retsef.co.il
- **תיעוד API אינטראקטיבי:** https://mail.retsef.co.il/docs
- **קובץ OpenAPI:** https://mail.retsef.co.il/openapi.yaml

---

## תוכן עניינים

1. [מה מקבלים, ומה שונה ממסמך הדרישות](#1-מה-מקבלים-ומה-שונה-ממסמך-הדרישות)
2. [הקמה: חשבון, דומיין ומפתחות](#2-הקמה-חשבון-דומיין-ומפתחות)
3. [אימות ומגבלות](#3-אימות-ומגבלות)
4. [שליחת מייל](#4-שליחת-מייל)
5. [שרשור מיילים (Re:)](#5-שרשור-מיילים-re)
6. [מצב מייל](#6-מצב-מייל)
7. [Webhooks: אירועים על כל מייל](#7-webhooks-אירועים-על-כל-מייל)
8. [מפתח בדיקה](#8-מפתח-בדיקה)
9. [השינויים שצריך לעשות אצל מגנט](#9-השינויים-שצריך-לעשות-אצל-מגנט)
10. [קודי שגיאה](#10-קודי-שגיאה)
11. [רשימת בדיקות לפני מעבר](#11-רשימת-בדיקות-לפני-מעבר)
12. [שאלות נפוצות](#12-שאלות-נפוצות)

---

## 1. מה מקבלים, ומה שונה ממסמך הדרישות

מסמך הדרישות של מגנט מתאר שתי אפשרויות: גישה ישירה ל-SES, או API של הספק (סעיף 4 במסמך). **העבודה תהיה דרך ה-API.** כך מגנט לא צריכה לנהל בעצמה חשבון AWS, הרשאות IAM, configuration set או SNS. המערכת מטפלת בכל אלה.

### עמידה בדרישות של סעיף 4 (API של הספק)

| דרישה במסמך | איך זה עובד אצלנו |
| --- | --- |
| שליחת מייל גולמי או כותרות מותאמות: Message-ID, In-Reply-To, References | הכותרות `Message-ID`, `In-Reply-To` ו-`References` עוברות כמו שהן. כל מייל מחזיר את ה-Message-ID שלו. [סעיף 5](#5-שרשור-מיילים-re) |
| קבצים מצורפים, CC ו-BCC | עד 10 קבצים ו-10MB למייל. CC ו-BCC במייל אחד, עם מצב לכל נמען. BCC לא מופיע בכותרות |
| כתובת שולח חופשית מכל כתובת בדומיין המאומת | כל כתובת ב-`magnetads.co.il`, בלי רשימה סגורה. כל איש צוות שולח מהכתובת שלו |
| מזהה ייחודי לכל מייל בתשובה | `messages[].id` (UUID), ובנוסף `message_id_header` |
| Webhook לכל מייל (נמסר, חזר, ספאם, נדחה) עם אותו מזהה | אירועים חתומים לכל מייל, עם `message_id` ו-`recipient`. [סעיף 7](#7-webhooks-אירועים-על-כל-מייל) |
| תיעוד מלא של ה-API ומפתח בדיקה | התיעוד ב-`/docs`, ומפתחות בדיקה (`mk_test_…`). [סעיף 8](#8-מפתח-בדיקה) |

### מה שונה מסעיפים 1–3 במסמך (גישה ישירה ל-SES)

| במסמך הדרישות | בפועל |
| --- | --- |
| אזור eu-central-1 או eu-west-1 | השליחה יוצאת מ-Amazon SES באזור **il-central-1 (תל אביב)**. אין לזה השפעה על מסירה או על מהירות |
| Configuration set בשם `magnet-default` | מנוהל אצלנו. לא צריך ליצור |
| SNS ל-`…/functions/v1/ses-events` | במקום SNS של אמזון, המערכת שולחת webhook חתום משלה. צריך להתאים את הפונקציה `ses-events`. [סעיף 9.3](#93-עדכון-הפונקציה-ses-events-ל-webhooks-שלנו) |
| Suppression list ברמת החשבון | פעיל: חזרה קשה חוסמת את הכתובת אצל כולם, ותלונה חוסמת אותה בחשבון של מגנט |
| משתמש IAM, `AWS_ACCESS_KEY_ID` ו-`AWS_SECRET_ACCESS_KEY` | לא צריך. במקומם יש **מפתח API** ו**סוד webhook** |
| יציאה מ-sandbox, 10,000 ביום ו-10 בשנייה | החשבון ב-SES כבר מחוץ ל-sandbox. מכסת החשבון של מגנט אצלנו עולה אוטומטית. [סעיף 3](#3-אימות-ומגבלות) |
| IP ייעודי | לא נדרש. IP משותף של SES |
| קליטת מיילים נכנסים | נשארת ב-Cloudflare Email Routing, בלי שינוי. אין התנגשות: רשומות ה-MX שלנו נמצאות רק על `bounce.magnetads.co.il` |

### מה מגנט מקבלת בסוף ההקמה

1. מפתח API אמיתי (`mk_live_…`) ומפתח בדיקה (`mk_test_…`).
2. סוד webhook (`whsec_…`) לאימות האירועים.
3. דומיין `magnetads.co.il` מאומת, עם DKIM של 2048 ביט ו-MAIL FROM ב-`bounce.magnetads.co.il`.
4. כתובת ה-API: `https://mail.retsef.co.il`.

הסודות נשמרים ישירות ב-Supabase secrets של הפרויקט, ולא נשלחים בצ'אט או במייל.

---

## 2. הקמה: חשבון, דומיין ומפתחות

### 2.1 פתיחת חשבון

1. נכנסים ל-https://mail.retsef.co.il ← **פתיחת חשבון**.
2. ממלאים שם, שם העסק (`מגנט ADS`), כתובת העסק, מייל וסיסמה.
3. ב-**הגדרות חשבון** ממלאים שם עסק, כתובת ומייל ליצירת קשר. הפרטים האלה מופיעים בתחתית כל דיוור, כפי שהחוק מחייב.

### 2.2 אימות הדומיין `magnetads.co.il`

1. **דומיינים** ← מוסיפים `magnetads.co.il`.
2. הדרך המהירה היא **חיבור אוטומטי ל-Cloudflare**:
   1. ב-Cloudflare: My Profile ← API Tokens ← Create Token ← תבנית **Edit zone DNS**.
   2. ב-Zone Resources בוחרים Specific zone ← `magnetads.co.il` ← Create Token.
   3. מדביקים את המפתח במסך הדומיין ← **הוספת הרשומות**.

   המערכת מוסיפה את כל הרשומות במצב DNS only ומאמתת מיד. המפתח משמש רק לפעולה הזו ולא נשמר.
3. דרך חלופית: **הורדת קובץ DNS**, ואז ב-Cloudflare: DNS ← Records ← Import and Export ← Import, בלי לסמן "Proxy imported DNS records".

הרשומות שנוספות:

| מטרה | סוג | שם | ערך |
| --- | --- | --- | --- |
| DKIM (3 רשומות) | CNAME | `<token>._domainkey.magnetads.co.il` | `<token>.dkim.il-central-1.amazonses.com` |
| כתובת החזרות | MX | `bounce.magnetads.co.il` | `10 feedback-smtp.il-central-1.amazonses.com` |
| SPF של כתובת ההחזרות | TXT | `bounce.magnetads.co.il` | `v=spf1 include:amazonses.com ~all` |
| DMARC (רק אם אין) | TXT | `_dmarc.magnetads.co.il` | `v=DMARC1; p=none; adkim=r; aspf=r` |

רשומה קיימת לא נמחקת. אם כבר קיימת רשומת DMARC, המערכת משאירה אותה כמו שהיא. רשומות ה-MX והגדרות SPF של Cloudflare Email Routing בדומיין הראשי לא משתנות.

הדומיין מאומת כש-DKIM, MAIL FROM ו-DMARC תקינים. המערכת בודקת לבד כל 10 דקות.

### 2.3 מפתחות API

**מפתחות API** ← יוצרים שני מפתחות:
- `magnet-crm-test` מסוג **מפתח בדיקה**: לפיתוח ולבדיקות.
- `magnet-crm-production` מסוג **מפתח אמיתי**: לייצור.

כל מפתח מוצג **פעם אחת בלבד**. שומרים אותו ישר ב-Supabase:

```bash
supabase secrets set MAILER_API_KEY=mk_live_...
```

```bash
supabase secrets set MAILER_TEST_API_KEY=mk_test_...
```

### 2.4 Webhook

**Webhooks** ← מוסיפים את הכתובת `https://rucltqmtefvlrjhbedqu.supabase.co/functions/v1/ses-events`. אפשר לבחור אירועים, ואם לא בוחרים, נשלחים כולם.

סוד החתימה (`whsec_…`) מוצג פעם אחת:

```bash
supabase secrets set MAILER_WEBHOOK_SECRET=whsec_...
```

את ה-webhook אפשר להגדיר גם דרך ה-API: `POST /v1/webhooks` עם `{"url": "..."}`.

---

## 3. אימות ומגבלות

כל בקשה נושאת את המפתח בכותרת:

```http
Authorization: Bearer mk_live_xxxxxxxxxxxxxxxx
Content-Type: application/json
```

| מגבלה | ערך |
| --- | --- |
| בקשות API | 600 בדקה לכל מפתח (10 בשנייה). מעבר לזה מתקבלת תשובה `429` |
| נמענים במייל | עד 50 (to, cc ו-bcc יחד) |
| קבצים מצורפים | עד 10 קבצים ו-10MB למייל, לפני קידוד |
| גודל גוף HTML | עד 2MB |
| מכסה יומית | עולה אוטומטית לפי איכות השליחה. המכסה הנוכחית ב-`GET /v1/me` |

### המכסה היומית

חשבון חדש מתחיל ב-200 מיילים ביום. המכסה עולה אוטומטית, בלי בקשה:

| שלב | מכסה יומית | מתי |
| --- | --- | --- |
| חדש | 200 | מיד עם פתיחת החשבון |
| מאומת | 1,000 | ברגע שהדומיין מאומת ופרטי העסק מולאו |
| מבוסס | 5,000 | אחרי 3 ימים עם לפחות 50 מיילים, פחות מ-2% חזרות ופחות מ-0.1% תלונות |
| ותיק | 20,000 | אחרי עוד 7 ימים תקינים |
| מוביל | 50,000 | אחרי עוד 30 ימים תקינים |

אם צריך מכסה גבוהה יותר מההתחלה, למשל 10,000 ביום כבר במעבר, פונים למפעיל המערכת. הוא יכול לקבוע מכסה ידנית.

**השעיה אוטומטית:** אם בשבוע האחרון יש יותר מ-5% חזרות או יותר מ-0.3% תלונות (מתוך לפחות 100 מיילים), החשבון מושעה ונשלח webhook מסוג `account.suspended`.

כשעוברים את המכסה, השליחה נדחית עם קוד `daily_limit_exceeded` (סטטוס 429). המכסה מתאפסת בחצות לפי שעון ישראל.

---

## 4. שליחת מייל

### `POST /v1/emails`

#### שדות

| שדה | סוג | חובה | הסבר |
| --- | --- | --- | --- |
| `from` | מחרוזת או אובייקט | כן | `"דנה <dana@magnetads.co.il>"`, `"dana@magnetads.co.il"` או `{"email": "...", "name": "..."}`. כל כתובת בדומיין מאומת |
| `to` | מחרוזת או מערך | כן | כתובת אחת או מערך. גם הפורמט `"Name <email>"` נתמך |
| `cc` | מחרוזת או מערך | לא | עותק |
| `bcc` | מחרוזת או מערך | לא | עותק מוסתר. לא מופיע בכותרות |
| `reply_to` | מחרוזת | לא | כתובת לתשובות |
| `subject` | מחרוזת | כן | נושא |
| `html` | מחרוזת | אחד מהשניים | גוף HTML |
| `text` | מחרוזת | אחד מהשניים | גוף טקסט. אם חסר, נוצר אוטומטית מה-HTML |
| `headers` | אובייקט | לא | `Message-ID`, `In-Reply-To`, `References`, וכל כותרת שמתחילה ב-`X-` |
| `attachments` | מערך | לא | `[{ "filename": "...", "content": "<base64>", "content_type": "application/pdf" }]` |
| `metadata` | אובייקט | לא | כל מידע שלכם, למשל `lead_id`. חוזר בכל webhook של המייל |
| `type` | `transactional` / `marketing` | לא | ברירת מחדל `transactional`. `marketing` מוסיף קישור הסרה ומעקב פתיחות והקלקות |
| `ad_label` | בוליאני | לא | להוסיף "פרסומת" לתחילת הנושא. ברירת מחדל: לפי הגדרת החשבון במיילים מסוג `marketing`, וכבוי במיילים תפעוליים. חוק התקשורת מחייב את המילה בדיוור פרסומי |
| `scheduled_at` | ISO 8601 | לא | שליחה מתוזמנת |

כותרת אופציונלית: `Idempotency-Key`. בקשה חוזרת עם אותו מפתח מחזירה את המייל המקורי ולא שולחת שוב. מומלץ מאוד, למשל `crm-msg-<id>`.

#### איך הנמענים מתחלקים

- **בלי `cc` ובלי `bcc`:** כל כתובת ב-`to` מקבלת מייל נפרד, עם `id` ו-Message-ID משלה. אף נמען לא רואה את האחרים.
- **עם `cc` או `bcc`:** נשלח מייל אחד לכולם, כמו מתוכנת דואר רגילה. יש `id` אחד ומצב לכל נמען.

#### דוגמה: מייל פשוט מאיש צוות

```bash
curl https://mail.retsef.co.il/v1/emails \
  -H "Authorization: Bearer $MAILER_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: crm-msg-48213" \
  -d '{
    "from": "דנה ממגנט <dana@magnetads.co.il>",
    "to": "lead@example.com",
    "subject": "הצעת מחיר לקמפיין",
    "html": "<div dir=\"rtl\">שלום, מצורפת הצעת המחיר.</div>",
    "metadata": { "lead_id": "48213", "source": "crm" }
  }'
```

#### דוגמה: CC, BCC וקובץ מצורף

```json
{
  "from": { "email": "dana@magnetads.co.il", "name": "דנה ממגנט" },
  "to": ["lead@example.com"],
  "cc": ["manager@example.com"],
  "bcc": ["archive@magnetads.co.il"],
  "reply_to": "sales@magnetads.co.il",
  "subject": "הצעת מחיר",
  "html": "<div dir=\"rtl\">...</div>",
  "attachments": [
    { "filename": "quote.pdf", "content": "JVBERi0xLjQK...", "content_type": "application/pdf" }
  ]
}
```

#### תשובה (202)

```json
{
  "duplicate": false,
  "test": false,
  "used_fallback": false,
  "from_email": "dana@magnetads.co.il",
  "warnings": [],
  "messages": [
    {
      "id": "5f0c2a1e-7d6b-4a3e-9a51-1c2f8e0d9b77",
      "to": "lead@example.com",
      "to_list": ["lead@example.com"],
      "cc": ["manager@example.com"],
      "bcc": ["archive@magnetads.co.il"],
      "message_id_header": "<5f0c2a1e-7d6b-4a3e-9a51-1c2f8e0d9b77@magnetads.co.il>",
      "status": "queued"
    }
  ]
}
```

- `id` הוא המזהה שמופיע בכל webhook ובכל שאילתה. שומרים אותו.
- `message_id_header` הוא ה-Message-ID של המייל, כמו שהנמען יראה אותו. שומרים אותו כדי להשיב על המייל בהמשך ([סעיף 5](#5-שרשור-מיילים-re)).
- `status: "suppressed"` אומר שהכתובת חסומה, כי חזרה בעבר או התלוננה, והמייל לא נשלח.
- המייל נכנס לתור ויוצא תוך שניות. מיילים תפעוליים תמיד קודמים לדיוורים.

#### דוגמה: פונקציית שליחה ב-Supabase Edge Function (Deno)

```ts
// supabase/functions/_shared/mailer.ts
const MAILER_URL = 'https://mail.retsef.co.il/v1/emails';

export interface SendEmailInput {
  from: string;                    // "דנה <dana@magnetads.co.il>"
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  replyTo?: string;
  subject: string;
  html?: string;
  text?: string;
  inReplyTo?: string;              // Message-ID of the message being answered
  references?: string[];           // the thread's Message-IDs, oldest first
  attachments?: { filename: string; content: string; contentType?: string }[];
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
}

export async function sendEmail(input: SendEmailInput) {
  const headers: Record<string, string> = {};
  if (input.inReplyTo) headers['In-Reply-To'] = input.inReplyTo;
  if (input.references?.length) headers['References'] = input.references.join(' ');

  const res = await fetch(MAILER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${Deno.env.get('MAILER_API_KEY')}`,
      'Content-Type': 'application/json',
      ...(input.idempotencyKey ? { 'Idempotency-Key': input.idempotencyKey } : {}),
    },
    body: JSON.stringify({
      from: input.from,
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      reply_to: input.replyTo,
      subject: input.subject,
      html: input.html,
      text: input.text,
      headers,
      attachments: input.attachments?.map((a) => ({ filename: a.filename, content: a.content, content_type: a.contentType })),
      metadata: input.metadata,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${data.error?.code}: ${data.error?.message}`);
  const m = data.messages[0];
  return { id: m.id as string, messageId: m.message_id_header as string, status: m.status as string };
}
```

---

## 5. שרשור מיילים (Re:)

כדי שתשובה תופיע אצל הנמען באותו שרשור, תוכנת הדואר שלו צריכה לזהות אותה לפי הכותרות.

1. **כל מייל שיוצא:** שומרים ב-CRM את `message_id_header` שחזר בתשובה.
2. **כל מייל שנכנס** (דרך Cloudflare Email Routing): שומרים את הכותרות `Message-ID` ו-`References` שלו.
3. **כשמשיבים:**
   - `In-Reply-To` = ה-Message-ID של המייל שעליו משיבים.
   - `References` = ה-`References` של אותו מייל, ובסופו ה-Message-ID שלו, מופרדים ברווחים.
   - הנושא מתחיל ב-`Re: ` (המערכת לא מוסיפה אותו לבד).

```ts
await sendEmail({
  from: 'דנה ממגנט <dana@magnetads.co.il>',
  to: incoming.from,
  subject: incoming.subject.startsWith('Re:') ? incoming.subject : `Re: ${incoming.subject}`,
  html: replyHtml,
  inReplyTo: incoming.messageId,
  references: [...incoming.references, incoming.messageId],
  metadata: { lead_id: lead.id, thread_id: thread.id },
});
```

**Message-ID מותאם:** אפשר לקבוע Message-ID בעצמכם, למשל כדי שיהיה ידוע עוד לפני השליחה: `"headers": { "Message-ID": "<crm-48213-1@magnetads.co.il>" }`. הפורמט הוא `<מזהה@דומיין>`. מותר רק במייל שיוצא כמייל אחד, כלומר נמען אחד ב-`to` או שימוש ב-`cc`/`bcc`.

---

## 6. מצב מייל

### `GET /v1/emails/{id}`

```json
{
  "id": "5f0c2a1e-...",
  "status": "delivered",
  "to_email": "lead@example.com",
  "cc": ["manager@example.com"],
  "bcc": [],
  "from_email": "dana@magnetads.co.il",
  "subject": "הצעת מחיר",
  "message_id_header": "<5f0c2a1e-...@magnetads.co.il>",
  "metadata": { "lead_id": "48213" },
  "sent_at": "2026-11-04T10:15:02Z",
  "recipients": [
    { "email": "lead@example.com", "kind": "to", "status": "delivered" },
    { "email": "manager@example.com", "kind": "cc", "status": "bounced", "detail": "smtp; 550 5.1.1 user unknown" }
  ],
  "events": [
    { "type": "delivered", "data": { "recipient": "lead@example.com" }, "created_at": "..." }
  ]
}
```

| מצב | משמעות |
| --- | --- |
| `queued` | בתור לשליחה |
| `sending` | בשליחה עכשיו |
| `sent` | נמסר ל-Amazon SES |
| `delivered` | שרת הדואר של הנמען קיבל את המייל |
| `bounced` | חזר: הכתובת לא קיימת, או שהתיבה מלאה לאורך זמן |
| `complained` | הנמען סימן את המייל כספאם |
| `failed` | נכשל, למשל דומיין לא מאומת או דחייה של SES. הסיבה ב-`last_error` |
| `suppressed` | לא נשלח, כי הכתובת חסומה |

`GET /v1/emails` מחזיר רשימה, עם הסינונים `status`, `to`, `limit` ו-`offset`.

---

## 7. Webhooks: אירועים על כל מייל

### 7.1 מבנה הבקשה

המערכת שולחת `POST` עם JSON:

```json
{
  "type": "email.delivered",
  "created_at": "2026-11-04T10:15:04.512Z",
  "data": {
    "message_id": "5f0c2a1e-7d6b-4a3e-9a51-1c2f8e0d9b77",
    "to": "lead@example.com",
    "recipient": "lead@example.com",
    "recipient_type": "to",
    "metadata": { "lead_id": "48213" },
    "test": false
  }
}
```

`message_id` הוא ה-`id` שחזר בשליחה. `recipient` הוא הנמען שהאירוע נוגע לו, וזה חשוב במייל עם CC.

### 7.2 האירועים, וההתאמה לאירועים של SES

| אירוע SES (במסמך שלכם) | האירוע אצלנו | שדות נוספים ב-`data` |
| --- | --- | --- |
| Send | `email.sent` | `recipients`, `from`, `message_id_header` |
| Delivery | `email.delivered` | |
| DeliveryDelay | `email.delayed` | `detail` |
| Bounce | `email.bounced` | `bounce_type` (`hard` או `soft`), `detail` |
| Complaint | `email.complained` | |
| Reject | `email.failed` | `error` |
| | `email.suppressed` | `reason`. המייל לא נשלח, כי הכתובת חסומה |
| | `email.opened`, `email.clicked` | רק במיילים מסוג `marketing`, אם לא הפעלתם מעקב גם למיילים תפעוליים |
| | `email.unsubscribed` | רק בדיוורים |
| | `domain.verified`, `domain.failed`, `domain.degraded` | `domain` |
| | `account.suspended` | `reason` |

### 7.3 אימות החתימה

כל בקשה מגיעה עם הכותרת:

```
X-Mailer-Signature: t=1793780104,v1=Qm9f3...
```

- `t`: זמן השליחה (Unix, בשניות).
- `v1`: HMAC-SHA256 של המחרוזת `<t>.<גוף הבקשה הגולמי>`, עם הסוד `whsec_…`, בקידוד base64url בלי ריפוד.

חשוב לאמת את החתימה על **הגוף הגולמי**, לפני `JSON.parse`, ולדחות בקשות ישנות מ-5 דקות.

### 7.4 ניסיונות חוזרים

כתובת שלא עונה בקוד 2xx תוך 10 שניות מקבלת ניסיונות חוזרים: אחרי 30 שניות, 2 דקות, 10 דקות, שעה ו-6 שעות. אחרי זה האירוע מסומן כנכשל.

אותו אירוע יכול להגיע פעמיים, ולכן הטיפול צריך להיות אידמפוטנטי: מפתח ייחודי לפי `message_id` + `type` + `recipient`.

---

## 8. מפתח בדיקה

מפתח `mk_test_…` עובר את כל התהליך: בדיקת הבקשה, תור, בניית המייל ו-webhooks. **רק המייל עצמו לא נשלח.** הוא מאפשר:
- לפתח לפני שהדומיין מאומת. התשובה תכלול `"warnings": ["domain_not_verified"]`.
- לבדוק את הטיפול בכל סוגי האירועים, לפי תחילת כתובת הנמען:

| כתובת נמען | מה קורה |
| --- | --- |
| `bounce…@כל-דומיין` | `email.sent` ואחריו `email.bounced` (`hard`) |
| `complaint…@כל-דומיין` | `email.sent`, `email.delivered`, `email.complained` |
| `delay…@כל-דומיין` | `email.sent`, `email.delayed`, `email.delivered` |
| כל כתובת אחרת | `email.sent`, `email.delivered` |

אירועים של מפתח בדיקה מסומנים `"test": true`. הם לא נספרים במכסה ולא חוסמים כתובות אמיתיות.

---

## 9. השינויים שצריך לעשות אצל מגנט

### 9.1 החלפת השליחה דרך Resend

בכל מקום שקורא ל-Resend (CRM, מייל פתיחה, מערכת הערוצים, העברת לידים), מחליפים את הקריאה בפונקציה `sendEmail` מסעיף 4.

| Resend | מערכת הדיוור |
| --- | --- |
| `POST https://api.resend.com/emails` | `POST https://mail.retsef.co.il/v1/emails` |
| `Authorization: Bearer re_…` | `Authorization: Bearer mk_live_…` |
| `from: "Name <a@b>"` | זהה |
| `to`, `cc`, `bcc` | זהה |
| `reply_to` | זהה (מחרוזת אחת) |
| `subject`, `html`, `text` | זהה |
| `headers` | זהה, למשל `In-Reply-To` ו-`References` |
| `attachments[].filename`, `content` (base64) | זהה. במקום `contentType` כותבים `content_type` |
| `attachments[].path` (URL) | **לא נתמך.** צריך להוריד את הקובץ ולשלוח אותו ב-base64 |
| `tags: [{name, value}]` | `metadata: { name: value }` |
| `scheduled_at` | זהה |
| כותרת `Idempotency-Key` | זהה |
| תשובה: `{ "id": "..." }` | `messages[0].id`, ובנוסף `messages[0].message_id_header` |

### 9.2 שמירת מזהים בטבלאות של ה-CRM

בטבלת המיילים היוצאים מוסיפים שלוש עמודות:
- `mailer_id uuid`: המזהה שחזר (`messages[0].id`). לפיו מתאימים webhooks.
- `message_id_header text`: לשרשור תשובות.
- `delivery_status text`: מתעדכן מה-webhooks.

```sql
ALTER TABLE outgoing_emails
  ADD COLUMN mailer_id uuid UNIQUE,
  ADD COLUMN message_id_header text,
  ADD COLUMN delivery_status text DEFAULT 'queued';
```

אפשר להעביר מזהה פנימי ב-`metadata` (למשל `outgoing_email_id`). הוא חוזר בכל webhook, וכך אפשר להתאים אירועים גם בלי `mailer_id`.

### 9.3 עדכון הפונקציה `ses-events` ל-webhooks שלנו

הפונקציה הקיימת מתוכננת לקבל הודעות SNS של אמזון (SubscriptionConfirmation ואז Notification עם JSON מקונן). צריך להחליף אותה בטיפול ב-webhook שלנו: אין אישור מנוי, ואין JSON מקונן.

```ts
// supabase/functions/ses-events/index.ts
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SECRET = Deno.env.get('MAILER_WEBHOOK_SECRET')!;
const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

function base64url(bytes: ArrayBuffer) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function verify(raw: string, header: string | null) {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=', 2)));
  const t = Number(parts.t);
  if (!t || Math.abs(Date.now() / 1000 - t) > 300) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = base64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${raw}`)));
  // constant-time comparison
  if (sig.length !== (parts.v1 ?? '').length) return false;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ parts.v1.charCodeAt(i);
  return diff === 0;
}

const STATUS: Record<string, string> = {
  'email.sent': 'sent',
  'email.delivered': 'delivered',
  'email.delayed': 'delayed',
  'email.bounced': 'bounced',
  'email.complained': 'complained',
  'email.failed': 'failed',
  'email.suppressed': 'suppressed',
};

Deno.serve(async (req) => {
  const raw = await req.text();
  if (!(await verify(raw, req.headers.get('x-mailer-signature')))) return new Response('bad signature', { status: 401 });

  const event = JSON.parse(raw) as { type: string; created_at: string; data: any };
  const d = event.data;

  // Idempotent: the same event may arrive twice
  const { error: dup } = await supabase.from('email_events').insert({
    mailer_id: d.message_id,
    type: event.type,
    recipient: d.recipient ?? d.to ?? null,
    payload: event,
    occurred_at: event.created_at,
  });
  if (dup?.code === '23505') return new Response('ok');

  const status = STATUS[event.type];
  if (status && d.message_id && (d.recipient_type ?? 'to') === 'to') {
    await supabase.from('outgoing_emails').update({ delivery_status: status }).eq('mailer_id', d.message_id);
  }
  if (event.type === 'email.bounced' && d.bounce_type === 'hard') {
    await supabase.from('leads').update({ email_invalid: true }).eq('email', d.recipient);
  }
  if (event.type === 'email.complained') {
    await supabase.from('leads').update({ email_opt_out: true }).eq('email', d.recipient);
  }
  return new Response('ok');
});
```

טבלת האירועים, עם מפתח ייחודי שמונע כפילויות:

```sql
CREATE TABLE email_events (
  id bigserial PRIMARY KEY,
  mailer_id uuid,
  type text NOT NULL,
  recipient text,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  UNIQUE (mailer_id, type, recipient)
);
```

שמות הטבלאות והעמודות (`outgoing_emails`, `leads` וכו') הם דוגמה. מתאימים אותם למבנה של מגנט.

אם הפונקציה רצה עם `verify_jwt`, צריך לכבות אותו לפונקציה הזו (`supabase functions deploy ses-events --no-verify-jwt`), כי הבקשות מגיעות מהמערכת שלנו, בלי JWT של Supabase. האבטחה היא דרך החתימה.

### 9.4 סודות

| סוד ב-Supabase | ערך |
| --- | --- |
| `MAILER_API_KEY` | `mk_live_…` |
| `MAILER_TEST_API_KEY` | `mk_test_…` (לסביבת פיתוח) |
| `MAILER_WEBHOOK_SECRET` | `whsec_…` |

את המפתחות של Resend אפשר למחוק אחרי שהמעבר הושלם. אין צורך ב-`AWS_ACCESS_KEY_ID` או ב-`AWS_SECRET_ACCESS_KEY`.

### 9.5 DNS

- מוסיפים את הרשומות מסעיף 2.2, אוטומטית או בייבוא קובץ.
- **לא** מוחקים את רשומות Cloudflare Email Routing (MX ו-SPF בדומיין הראשי).
- את רשומות Resend (בדרך כלל `resend._domainkey` ו-`send.magnetads.co.il`) מוחקים רק אחרי שהמעבר הושלם ואין יותר שליחות דרך Resend.
- אם בעתיד רוצים להחמיר את DMARC ל-`p=quarantine` (וגם להציג לוגו שולח, BIMI), צריך לוודא קודם שכל מי ששולח בשם הדומיין עובר דרכנו או מאומת אחרת.

### 9.6 סדר מעבר מומלץ

1. מקימים חשבון ומאמתים את הדומיין (סעיף 2). רשומות Resend נשארות במקביל.
2. מפתחים ובודקים עם מפתח הבדיקה (סעיף 8 ורשימת הבדיקות בסעיף 11).
3. מעבירים קודם מערכת אחת עם מפתח אמיתי, למשל העברת לידים. בודקים יום שלם בממשק, במסך "מיילים שנשלחו".
4. מעבירים את שאר המערכות. ה-CRM, בגלל השרשורים, עובר אחרון.
5. אחרי שבוע בלי שליחות דרך Resend, מוחקים את המפתחות ואת רשומות ה-DNS של Resend.

---

## 10. קודי שגיאה

כל שגיאה מגיעה בפורמט:

```json
{ "error": { "code": "domain_not_verified", "message": "הדומיין magnetads.co.il לא מאומת עבור השולח הזה" } }
```

| קוד | סטטוס | משמעות ומה עושים |
| --- | --- | --- |
| `validation_error` | 400 | שדה חסר או לא תקין. הפירוט ב-`message` וב-`details` |
| `invalid_json` | 400 | גוף הבקשה אינו JSON תקין |
| `unauthorized` | 401 | מפתח חסר, שגוי או מבוטל |
| `domain_not_verified` | 400 | כתובת השולח לא בדומיין מאומת |
| `freemail_not_allowed` | 400 | ניסיון לשלוח מכתובת Gmail או כתובת דואר חינמי אחרת |
| `domain_not_owned` | 403 | הדומיין רשום בחשבון אחר |
| `too_many_recipients` | 400 | יותר מ-50 נמענים |
| `invalid_message_id` | 400 | Message-ID לא בפורמט `<id@domain>` |
| `message_id_needs_single_message` | 400 | Message-ID מותאם עם כמה נמענים ב-`to` בלי cc/bcc |
| `daily_limit_exceeded` | 429 | עברתם את המכסה היומית. מתאפסת בחצות |
| `rate_limited` | 429 | יותר מ-600 בקשות בדקה. מחכים ומנסים שוב |
| `account_suspended` | 403 | החשבון מושעה. פונים למפעיל |
| `not_found` | 404 | המזהה לא קיים בחשבון |
| `internal_error` | 500 | תקלה זמנית. מנסים שוב עם אותו `Idempotency-Key` |

**ניסיונות חוזרים:** בשגיאות 429 ו-5xx מנסים שוב, עם המתנה הולכת וגדלה (1, 2, 4, 8 שניות) ועם אותו `Idempotency-Key`. בשגיאות 4xx אחרות אין טעם לנסות שוב.

---

## 11. רשימת בדיקות לפני מעבר

עם מפתח בדיקה:
- [ ] שליחה פשוטה מכתובת של איש צוות: מתקבל `id` ו-`message_id_header`.
- [ ] שליחה עם CC ו-BCC: מייל אחד. ב-`GET /v1/emails/{id}` מופיעים 3 נמענים.
- [ ] שליחה עם קובץ PDF מצורף.
- [ ] תשובה עם `In-Reply-To` ו-`References`: הכותרות נשמרות.
- [ ] `Idempotency-Key` כפול: מחזיר את אותו `id`, עם `duplicate: true`.
- [ ] webhooks: `email.sent` ו-`email.delivered` מגיעים, והחתימה מאומתת.
- [ ] נמען `bounce@example.com`: מגיע `email.bounced`, והליד מסומן.
- [ ] נמען `complaint@example.com`: מגיע `email.complained`.
- [ ] נמען `delay@example.com`: מגיע `email.delayed`.
- [ ] webhook עם חתימה שגויה נדחה בקוד 401.

עם מפתח אמיתי, אחרי שהדומיין מאומת:
- [ ] מייל ל-Gmail: ב"הצגת המקור" מופיעים SPF, DKIM ו-DMARC במצב PASS.
- [ ] תשובה מ-Gmail למייל שנשלח: מגיעה ל-Cloudflare Email Routing וממשיכה לשרשור ב-CRM.
- [ ] תשובה מה-CRM: מופיעה ב-Gmail באותו שרשור.

---

## 12. שאלות נפוצות

**האם המיילים יגיעו לספאם?**
הדומיין חתום ב-DKIM של `magnetads.co.il`, עם SPF מיושר דרך `bounce.magnetads.co.il` ו-DMARC. אלה הדרישות של Gmail ו-Yahoo. מעבר לזה, מה שקובע הוא התוכן ואיכות הרשימות.

**האם יש מעקב פתיחות במיילים אישיים?**
לא. במיילים תפעוליים (ברירת המחדל) אין פיקסל מעקב ואין שינוי בקישורים, כדי שמייל אישי ייראה כמו מייל רגיל. מעקב מופעל רק עם `"type": "marketing"`, או בהגדרה בחשבון.

**מה קורה לנמען שהתלונן או שהכתובת שלו חזרה?**
חזרה קשה חוסמת את הכתובת לכל שליחה. תלונה חוסמת אותה בחשבון של מגנט. שליחה לכתובת חסומה מחזירה `status: "suppressed"`. אפשר לראות ולשחרר חסימות ידניות ב-`GET/DELETE /v1/suppressions`.

**האם אפשר לשלוח מכתובת @gmail.com של איש צוות?**
לא. Gmail דוחה מיילים שמתחזים לכתובת Gmail משרת אחר, בגלל מדיניות ה-DMARC שלו. שולחים רק מכתובות ב-`magnetads.co.il`.

**מה גודל המייל המקסימלי?**
עד 10MB קבצים לפני קידוד. שימו לב: Gmail ו-Outlook דוחים מיילים מעל 25MB אחרי קידוד.

**האם אפשר לנהל גם דיוורים ורשימות דרך המערכת?**
כן, אם תרצו בהמשך: אנשי קשר, רשימות, תבניות ודיוורים, בממשק וב-API. לא חובה למעבר.

**למי פונים?**
למפעיל המערכת: מכסה גבוהה מההתחלה, שחרור חשבון מושעה, או שאלות על ה-API.
