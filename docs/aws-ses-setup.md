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
    }
  ]
}
```

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
AWS_ACCESS_KEY_ID=<מהמשתמש mailer-ses>
AWS_SECRET_ACCESS_KEY=<מהמשתמש mailer-ses>
```

## יציאה מ-sandbox

החשבון מוגבל כרגע ל-200 מיילים ביממה ולמייל אחד בשנייה. בקונסול של SES ב-il-central-1 נכנסים ל-Account dashboard → Request production access. נוסח מוצע:

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
