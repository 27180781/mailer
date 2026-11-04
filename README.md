# מערכת דיוור

פלטפורמת דיוור מרובת חשבונות: כל לקוח פותח חשבון, מאמת את הדומיין שלו ושולח דיוורים ומיילים תפעוליים, דרך ממשק בעברית או דרך API מלא.
חשבון מסוג «פלטפורמה» (כמו רצף) מנהל תחתיו שולחים (senders), שלכל אחד מהם דומיין משלו, ושולח בשמם עם גיבוי לכתובת של הפלטפורמה כשהדומיין לא מאומת.

- **שליחה:** Amazon SES כברירת מחדל, דרך שכבת ספק מופשטת (`src/providers`). אפשר להחליף ל-SMTP כללי או להוסיף ספק חדש בלי לגעת בשאר הקוד.
- **מסד נתונים:** PostgreSQL. גם תור השליחה יושב בו, אז אין צורך ב-Redis.
- **ריצה:** תהליך Node.js אחד שמריץ את ה-API, הממשק וה-worker (`ROLE=all`), או שני תהליכים נפרדים (`ROLE=web` ו-`ROLE=worker`).

## אימות דומיין לפי הדרישות של Gmail ו-Yahoo

| דרישה | מה המערכת עושה |
| --- | --- |
| DKIM | יוצרת זהות ב-SES עם מפתח 2048 ביט, ומציגה 3 רשומות CNAME |
| SPF מיושר | מגדירה MAIL FROM על `bounce.<domain>`, עם רשומת MX ורשומת SPF |
| DMARC | בודקת `_dmarc` של הדומיין ושל הדומיינים שמעליו. אם אין רשומה, מציעה `v=DMARC1; p=none; adkim=r; aspf=r` |
| From מיושר | אפשר לשלוח רק מדומיין מאומת של החשבון או של השולח. כתובות של Gmail ושאר ספקי הדואר החינמי עוברות לכתובת הגיבוי או נדחות |
| הסרה בלחיצה אחת | כותרות `List-Unsubscribe` ו-`List-Unsubscribe-Post` (RFC 8058) בכל מייל שיווקי. ההסרה מיידית |
| תלונות מתחת ל-0.3% | דיוור עם יותר מ-0.3% תלונות או יותר מ-5% חזרות (אחרי 500 מיילים) מושהה אוטומטית |

דומיין נחשב מאומת רק כש-DKIM, MAIL FROM ו-DMARC כולם תקינים. הבדיקה רצה כל 10 דקות במשך 72 שעות, ואחר כך פעם ביום. אם רשומה נמחקת, הדומיין עובר למצב `degraded` ונשלח webhook.

## הקמה

### 1. Amazon SES

1. בוחרים אזור (`SES_REGION`), ומבקשים יציאה מ-sandbox (Production access) בקונסולת SES.
2. יוצרים Configuration Set, למשל `mailer-events`, עם Event destination מסוג SNS לאירועים Delivery, Bounce, Complaint, Reject ו-DeliveryDelay.
3. ב-SNS יוצרים נושא (topic) ומנוי HTTPS לכתובת `https://<PUBLIC_URL>/webhooks/provider/ses`. המערכת מאשרת את המנוי לבד, אחרי שהיא בודקת את החתימה של SNS.
4. יוצרים משתמש IAM עם ההרשאות `ses:SendEmail`, `ses:SendRawEmail`, `ses:CreateEmailIdentity`, `ses:GetEmailIdentity`, `ses:DeleteEmailIdentity` ו-`ses:PutEmailIdentityMailFromAttributes`.

### 2. CapRover

1. מתקינים PostgreSQL מ-One-Click Apps.
2. יוצרים אפליקציה (למשל `mailer`), מפעילים HTTPS ומחברים את הדומיין של המערכת.
3. מגדירים את משתני הסביבה (ראו טבלה).
4. ב-Deployment של האפליקציה מפעילים App Token ומעתיקים אותו.

### 3. GitHub

ב-Settings → Secrets and variables → Actions מוסיפים:

| Secret | ערך |
| --- | --- |
| `CAPROVER_SERVER` | למשל `https://captain.example.co.il` |
| `CAPROVER_APP` | שם האפליקציה ב-CapRover |
| `CAPROVER_APP_TOKEN` | ה-App Token |

כל push ל-`main` מריץ בדיקות ואחר כך פורס. ה-migrations רצים אוטומטית כשהאפליקציה עולה.

### משתני סביבה

| משתנה | תיאור |
| --- | --- |
| `DATABASE_URL` | חיבור ל-PostgreSQL |
| `PUBLIC_URL` | הכתובת הציבורית של המערכת, לקישורי הסרה ומעקב |
| `APP_SECRET` | מחרוזת אקראית ארוכה לחתימת קישורים |
| `EMAIL_PROVIDER` | `ses` (ברירת מחדל), `smtp` או `log` (לפיתוח) |
| `SES_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | חיבור ל-SES |
| `SES_CONFIGURATION_SET` | ה-Configuration Set עם אירועי SNS |
| `SES_SNS_TOPIC_ARN` | **חובה.** מקבלים רק התראות מהנושא הזה. בלעדיו כל התראות SNS נדחות |
| `MAX_SEND_RATE` | מיילים בשנייה לכל המערכת, לפי המכסה ב-SES (ברירת מחדל 14) |
| `DAILY_SEND_CAP` | תקרה לכל המערכת: מיילים ב-24 שעות אחרונות (0 = בלי תקרה). מעליה המיילים מחכים בתור. שימושי כשחשבון ה-AWS משותף |
| `NEW_ACCOUNT_DAILY_LIMIT` | מכסה יומית לחשבון חדש שעוד לא אושר (ברירת מחדל 200) |
| `SUPER_ADMIN_EMAILS` | מיילים שמקבלים הרשאת מנהל-על בהרשמה |
| `RESERVED_DOMAINS` | דומיינים שה-identity שלהם מנוהל מחוץ למערכת, באותו חשבון AWS (למשל `retsef.co.il`). אי אפשר להוסיף או למחוק אותם, ותת-דומיינים שלהם מותרים רק לחשבון שקיבל הרשאה |
| `ROLE` | `all`, `web` או `worker` |
| `BACKUP_S3_ENDPOINT`, `BACKUP_S3_BUCKET`, `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY`, `BACKUP_PASSPHRASE` | גיבוי יומי מוצפן לדלי R2/S3. ראו [docs/backup.md](docs/backup.md) |

## API

אימות: `Authorization: Bearer mk_live_...`. מגבלה של 600 בקשות בדקה לכל מפתח. שגיאות חוזרות בפורמט `{"error": {"code", "message"}}`, עם הודעה בעברית.

| נתיב | תיאור |
| --- | --- |
| `POST /v1/emails` | שליחת מייל. תומך ב-`Idempotency-Key` |
| `GET /v1/emails`, `GET /v1/emails/:id` | מצב מייל, כולל אירועים |
| `GET/POST /v1/domains`, `GET/DELETE /v1/domains/:id`, `POST /v1/domains/:id/verify` | דומיינים |
| `GET/POST /v1/senders`, `GET/PATCH/DELETE /v1/senders/:id`, `POST /v1/senders/:id/domains` | שולחים (חשבון פלטפורמה בלבד) |
| `POST /v1/senders/resolve` | בדיקה מאיזו כתובת מייל ייצא בפועל, בלי לשלוח |
| `GET/POST /v1/contacts`, `POST /v1/contacts/import`, `GET/PATCH/DELETE /v1/contacts/:id` | אנשי קשר. `:id` יכול להיות גם כתובת המייל. `PATCH` משנה פרטים, מסיר מדיוור (`status`) ומצרף לרשימות או מוציא מהן |
| `GET/POST /v1/lists`, `PATCH/DELETE /v1/lists/:id`, `POST /v1/lists/:id/members`, `DELETE /v1/lists/:id/members/:contact` | רשימות. אפשר לצרף לפי מזהים או לפי מיילים |
| `GET/POST /v1/templates`, `GET/PATCH/DELETE /v1/templates/:id` | תבניות |
| `GET/POST /v1/campaigns`, `GET/PATCH/DELETE /v1/campaigns/:id` | דיוורים |
| `POST /v1/campaigns/:id/test`, `/send`, `/pause`, `/resume`, `/cancel`, `GET /v1/campaigns/:id/stats` | פעולות על דיוור |
| `GET/POST /v1/suppressions`, `DELETE /v1/suppressions/:email` | רשימת חסימה |
| `GET/POST /v1/webhooks`, `PATCH/DELETE /v1/webhooks/:id` | Webhooks |
| `GET/POST /v1/api-keys`, `DELETE /v1/api-keys/:id` | מפתחות |
| `GET /v1/me`, `PATCH /v1/account` | החשבון |

### דוגמה: רצף שולח חשבונית בשם עסק

```bash
curl https://mail.example.co.il/v1/emails \
  -H "Authorization: Bearer mk_live_..." \
  -H "Idempotency-Key: doc-10234-issued" \
  -H "Content-Type: application/json" \
  -d '{
    "sender_id": "<id של העסק>",
    "from": { "email": "invoices@shefa.co.il", "name": "שפע בע\"מ" },
    "fallback": "platform",
    "to": "customer@example.com",
    "subject": "חשבונית מס-קבלה 10234",
    "html": "<div dir=\"rtl\">מצורפת החשבונית</div>",
    "attachments": [{ "filename": "10234.pdf", "content": "<base64>", "content_type": "application/pdf" }],
    "metadata": { "document_id": "..." }
  }'
```

התשובה כוללת את `used_fallback`. כשהדומיין של העסק לא מאומת, המייל יוצא מ-`fallback_from_email` של החשבון, עם שם כמו «שפע בע"מ באמצעות רצף».

### Webhooks

כל אירוע נשלח ב-POST עם הכותרת `X-Mailer-Signature: t=<unix>,v1=<hmac>`. החתימה היא HMAC-SHA256 (base64url) של `<t>.<body>` עם סוד ה-webhook.
האירועים: `email.sent`, `email.delivered`, `email.bounced`, `email.complained`, `email.failed`, `email.suppressed`, `email.opened`, `email.clicked`, `email.unsubscribed`, `domain.verified`, `domain.failed`, `domain.degraded`, `campaign.paused`, `campaign.finished`, `contact.created`, `contact.updated`, `contact.unsubscribed`, `contact.deleted`, `contact.added_to_list`, `contact.removed_from_list`.

### Zapier ו-Make

יש אפליקציות מוכנות: [integrations/zapier](integrations/zapier/README.md) ו-[integrations/make](integrations/make/README.md). בשתיהן אפשר להוסיף ולעדכן מנויים, להסיר אותם מהדיוור, לשייך לרשימות ולשלוח מיילים. ה-triggers מיידיים, דרך webhooks.

## פיתוח

```bash
npm install
DATABASE_URL=postgres://... EMAIL_PROVIDER=log npm run dev
TEST_DATABASE_URL=postgres://... npm test
```

## הוספת ספק שליחה

מממשים את `EmailProvider` שב-`src/providers/types.ts`. הממשק כולל את `send`, `createDomain`, `getDomainStatus`, `deleteDomain` ו-`parseWebhook`. אחר כך רושמים את הספק ב-`src/providers/index.ts`. כל דומיין שומר באיזה ספק הוא נוצר, ולכן אפשר לעבור לספק חדש בהדרגה.

## חיבור אוטומטי ל-Cloudflare

במסך הדומיין, לקוח מדביק מפתח API של Cloudflare (תבנית Edit zone DNS, לדומיין שלו בלבד). המערכת מוסיפה את כל הרשומות ומאמתת מיד. המפתח משמש לבקשה הזו בלבד ולא נשמר.
רשומת DMARC קיימת לא משתנה לעולם, וכל הרשומות נוצרות במצב DNS only.

למפעיל: אם מגדירים `CLOUDFLARE_API_TOKEN`, חשבונות של מנהל-העל (וחשבונות עם הרשאה לדומיינים שמורים) מקבלים כפתור "הוספה אוטומטית" בלי להדביק מפתח. לקוחות רגילים לא יכולים להשתמש במפתח הזה.
API: `POST /v1/domains/:id/cloudflare` עם `{"token": "..."}` או `{"use_operator": true}`.
