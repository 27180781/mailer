# הקמת SES בחשבון ה-AWS של רצף

מערכת הדיוור רצה ב-CapRover ושולחת דרך Amazon SES בחשבון 010569743794, באזור il-central-1.
היא לא נוגעת בשרת של רצף ולא משתמשת ב-role שלו. ההרשאות שלה מגיעות ממשתמש IAM נפרד, שמורשה ל-SES בלבד.

## המשאבים שנוצרים (כולם בשם עם התחילית `mailer`)

| משאב | שם | הערות |
| --- | --- | --- |
| משתמש IAM | `mailer-ses` | בלי גישה לקונסול. מפתח גישה אחד, שנשמר רק במשתני הסביבה של האפליקציה ב-CapRover |
| Inline policy | `mailer-ses-only` | ראו למטה. מוגבל ל-SES ול-il-central-1 |
| SNS topic | `mailer-ses-events` | il-central-1 |
| SES configuration set | `mailer-events` | event destination ל-`mailer-ses-events`: DELIVERY, BOUNCE, COMPLAINT, REJECT, DELIVERY_DELAY |
| מנוי SNS | HTTPS אל `https://mail.retsef.co.il/webhooks/provider/ses` | מתווסף אחרי שהאפליקציה עולה. המערכת מאשרת אותו לבד |

לא נוצרים משאבים ל-SES בשם של רצף, ולא משתנים ה-role, ה-SSM, הגיבויים או ה-security group של רצף.

## מה רצף כבר הקים באותו חשבון (עדכון 3.11.2026)

- Stack בשם `retzef-ses`: identity מאומת ל-`retsef.co.il`, עם Easy DKIM ו-configuration set בשם `retzef-transactional`. שרת רצף שולח ממנו את המיילים התפעוליים שלו ישירות, דרך ה-role שלו.
- ב-Cloudflare: 3 רשומות DKIM, ורשומת `_dmarc.retsef.co.il` עם הערך `v=DMARC1; p=none;`.
- בקשת production access ל-SES ב-il-central-1 כבר הוגשה. האישור חל על כל החשבון, ולכן הוא מכסה גם את מערכת הדיוור.

מה זה אומר למערכת הדיוור:
- ה-identity של `retsef.co.il` שייך לרצף. המערכת מגדירה אותו כדומיין שמור (`RESERVED_DOMAINS=retsef.co.il`): אף חשבון לא יכול להוסיף אותו או למחוק אותו, וגם אם מישהו ינסה דרך ה-API, המערכת לא תיגע ב-identity שלו ב-SES. תת-דומיין שלו אפשר לאמת רק בחשבון שמנהל-העל סימן לו "מותר לאמת תת-דומיינים של דומיינים שמורים".
- אם בכל זאת מנסים להוסיף דומיין שכבר קיים כ-identity בחשבון, המערכת מסרבת. היא לא משתלטת עליו.
- המערכת שולחת רק עם `mailer-events`, ולא עם `retzef-transactional`.
- רשומת ה-DMARC של `retsef.co.il` חלה גם על התת-דומיינים, ולכן לא מוסיפים עוד רשומה. המערכת מציגה את הרשומה הקיימת כתקינה.
- מכסת השליחה של SES משותפת לרצף ולמערכת הדיוור. את `MAX_SEND_RATE` מגדירים מתחת למכסה, כך שיישאר מקום לרצף. למשל, אם המכסה היא 14 בשנייה, קובעים 10.

### דומיין השליחה של מערכת הדיוור: `mail.retsef.co.il`

כדי שהמוניטין של הדיוורים יהיה נפרד מזה של המיילים התפעוליים של רצף, מאמתים את `mail.retsef.co.il` כ-identity נפרד, דרך המערכת עצמה:
1. במערכת הדיוור, במסך ניהול החשבונות, מסמנים לחשבון את ההרשאה לתת-דומיינים שמורים.
2. בחשבון הזה, במסך דומיינים, מוסיפים את `mail.retsef.co.il`. המערכת יוצרת את ה-identity ב-SES ומציגה את הרשומות.
3. ב-Cloudflare מוסיפים את הרשומות, כולן במצב DNS only:
   - 3 רשומות CNAME של DKIM, בשמות `*._domainkey.mail.retsef.co.il`.
   - MX לתת-הדומיין `bounce.mail.retsef.co.il`, עם הערך `feedback-smtp.il-central-1.amazonses.com` ועדיפות 10.
   - TXT ל-`bounce.mail.retsef.co.il`, עם הערך `v=spf1 include:amazonses.com ~all`.
   - לא מוסיפים רשומת `_dmarc`.

רשומת ה-A של `mail.retsef.co.il` (לשרת ה-CapRover) לא מתנגשת עם הרשומות האלה.

## Policy למשתמש `mailer-ses`

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "MailerSesOnly",
      "Effect": "Allow",
      "Action": [
        "ses:SendEmail",
        "ses:SendRawEmail",
        "ses:CreateEmailIdentity",
        "ses:GetEmailIdentity",
        "ses:DeleteEmailIdentity",
        "ses:PutEmailIdentityMailFromAttributes",
        "ses:GetAccount"
      ],
      "Resource": "*",
      "Condition": { "StringEquals": { "aws:RequestedRegion": "il-central-1" } }
    },
    {
      "Sid": "NeverTouchRetzefIdentity",
      "Effect": "Deny",
      "Action": [
        "ses:CreateEmailIdentity",
        "ses:DeleteEmailIdentity",
        "ses:PutEmailIdentityMailFromAttributes",
        "ses:SendEmail",
        "ses:SendRawEmail"
      ],
      "Resource": "arn:aws:ses:il-central-1:010569743794:identity/retsef.co.il"
    }
  ]
}
```

**מה מוגדר בפועל (3.11.2026):** ב-stack בשם `mailer-ses` יש למשתמש שתי הצהרות:
- `SesInIsraelOnly` (Allow): כל הפעולות שלמעלה, ועוד SendBulkEmail, ListEmailIdentities, הגדרות DKIM, רשימת חסומים ותגיות. הכל על Resource `*`, עם התנאי `aws:RequestedRegion=il-central-1`.
- `DenyRetzefIdentity` (Deny): חוסמת על `identity/retsef.co.il` ועל `configuration-set/retzef-transactional` שליחה (כולל SendBulkEmail), יצירה ומחיקה, הגדרות DKIM, MAIL FROM, feedback ו-configuration set, ותגיות.

לכן שליחה מתת-דומיין של `retsef.co.il` עובדת רק אם התת-דומיין מאומת כ-identity נפרד. אחרת SES מנסה לשלוח דרך ה-identity של הדומיין הראשי, והשליחה נחסמת.

ה-Resource של ההרשאה הראשונה הוא `*`, כי כל לקוח של המערכת מאמת דומיין משלו, ואי אפשר לדעת מראש מה הדומיינים. ההרשאה השנייה חוסמת ברמת AWS כל שינוי או שליחה דרך ה-identity של רצף, גם אם תהיה תקלה בקוד.

## משתני סביבה באפליקציה ב-CapRover

```
PUBLIC_URL=https://mail.retsef.co.il
DATABASE_URL=postgres://<user>:<password>@srv-captain--<שם אפליקציית ה-Postgres>:5432/mailer
APP_SECRET=<מחרוזת אקראית ארוכה, למשל הפלט של openssl rand -base64 48>
SUPER_ADMIN_EMAILS=na73438@gmail.com
EMAIL_PROVIDER=ses
SES_REGION=il-central-1
SES_CONFIGURATION_SET=mailer-events
SES_SNS_TOPIC_ARN=arn:aws:sns:il-central-1:010569743794:mailer-ses-events
RESERVED_DOMAINS=retsef.co.il
MAX_SEND_RATE=1
AWS_ACCESS_KEY_ID=<מהמשתמש mailer-ses>
AWS_SECRET_ACCESS_KEY=<מהמשתמש mailer-ses>
```

## יציאה מ-sandbox

**רצף כבר הגיש את הבקשה, והיא חלה על כל החשבון. אין צורך להגיש שוב.**
עד האישור החשבון מוגבל ל-200 מיילים ביממה ולמייל אחד בשנייה, ואפשר לשלוח רק לכתובות מאומתות (למשל na73438@gmail.com). לכן בינתיים `MAX_SEND_RATE=1`. אחרי האישור מעלים לפי המכסה שאמזון נותנת, ומשאירים מקום לרצף.

אם אמזון יבקשו פרטים נוספים על מערכת הדיוור, זה הנוסח:

- Mail type: Transactional (גם מיילים שיווקיים מבוססי הסכמה נשלחים, ומסומנים בנפרד)
- Website URL: https://mail.retsef.co.il
- Use case description:

> We operate a multi-tenant email platform for Israeli businesses. It sends (1) transactional email on behalf of our accounting software, Retzef: tax invoices, receipts and payment requests to each business's own customers; and (2) opt-in newsletters for businesses that use the platform.
> Every sending domain must pass DKIM (Easy DKIM, 2048-bit), use a custom MAIL FROM domain, and publish DMARC before it can send. Free-mail sender addresses are not allowed.
> Recipients: transactional mail goes only to the customers of the issuing business. Marketing lists require recorded consent (source, time, IP), use double opt-in forms, and every marketing message has one-click List-Unsubscribe (RFC 8058) plus a visible Hebrew unsubscribe link, as required by Israeli anti-spam law (Communications Law, section 30A).
> Bounces and complaints arrive through an SES configuration set and SNS. Hard bounces are suppressed globally; complaints and unsubscribes are suppressed per account. A campaign pauses automatically above a 5% bounce rate or a 0.3% complaint rate. New accounts are limited to 200 messages a day until we approve them manually.
> We expect about 2,000 messages a day at first, growing to about 30,000 a day.

## הקמה ב-CapRover ו-Cloudflare עבור mail.retsef.co.il

1. **Cloudflare:** רשומת A בשם `mail` שמצביעה לכתובת ה-IP של שרת ה-CapRover. מצב **DNS only** (ענן אפור), כדי ש-CapRover יוכל להנפיק תעודת Let's Encrypt.
2. **CapRover, מסד נתונים:** One-Click Apps → PostgreSQL. אחרי ההתקנה יוצרים בו database בשם `mailer`.
3. **CapRover, האפליקציה:** אפליקציה חדשה בשם `mailer`:
   - HTTP Settings: Connect New Domain → `mail.retsef.co.il`, ואחר כך Enable HTTPS ו-Force HTTPS.
   - Container HTTP Port: `3000`.
   - App Configs: משתני הסביבה שלמעלה.
   - Deployment: Enable App Token.
4. **GitHub:** במאגר מוסיפים את הסודות `CAPROVER_SERVER`, `CAPROVER_APP` (`mailer`) ו-`CAPROVER_APP_TOKEN`, ומריצים מחדש את ה-workflow.
5. **בדיקה:** ‏`https://mail.retsef.co.il/health` מחזיר `{"ok":true}`. אחר כך פותחים חשבון עם המייל שב-`SUPER_ADMIN_EMAILS`.
6. **SNS:** מוסיפים מנוי HTTPS ל-topic `mailer-ses-events`, אל `https://mail.retsef.co.il/webhooks/provider/ses`. המנוי צריך לעבור לסטטוס Confirmed תוך דקה.
