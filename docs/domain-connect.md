# חיבור בלחיצה לספקי DNS (Domain Connect)

Domain Connect מאפשר ללקוח לאמת דומיין בלחיצה. הלקוח לוחץ על "חיבור ל-Cloudflare", עובר ל-Cloudflare, מאשר את הרשומות וחוזר מאומת, בלי מפתחות ובלי העתקה.
הצד שלנו בנוי. כדי שהכפתור יופיע, Cloudflare (וכל ספק DNS אחר בנפרד) צריכים לרשום את התבניות שלנו. עד אז הלקוחות משתמשים במפתח API של Cloudflare או בקובץ DNS.

- **ספק השירות (providerId):** `retsef.co.il`
- **התבניות:** בתיקייה [`docs/domain-connect/`](domain-connect/)

| קובץ | מה הוא מוסיף | מתי משתמשים בו |
| --- | --- | --- |
| `retsef.co.il.mailer.json` | DKIM, MAIL FROM (MX ו-SPF), DMARC | לדומיין שאין לו רשומת DMARC |
| `retsef.co.il.mailer-nodmarc.json` | DKIM, MAIL FROM (MX ו-SPF) | לדומיין שכבר יש לו DMARC, כדי שלא תיווצר רשומה כפולה |
| `retsef.co.il.mailer-bimi.json` | רשומת BIMI (לוגו שולח) | אחרי העלאת לוגו |

המערכת בוחרת את התבנית המתאימה לבד. ה-SPF נוסף ברשומה מסוג `SPFM`, שמתמזגת עם SPF קיים, כפי ש-Cloudflare דורשת.

## איך זה עובד טכנית

1. **זיהוי הספק:** המערכת קוראת את רשומת `_domainconnect.<domain>`. Cloudflare מפרסמת אותה אוטומטית לכל דומיין שלה, ומשם מגיעים לכתובות ה-API שלה.
2. **בדיקת תמיכה:** המערכת בודקת אם ספק ה-DNS מכיר את התבנית. התשובה נשמרת לשעה.
3. **חתימה:** המערכת בונה קישור `apply` חתום ב-RSA-SHA256. החתימה היא הפרמטר האחרון, ו-`key=_dck1` מציין איפה המפתח הציבורי.
4. **אישור וחזרה:** הלקוח מאשר אצל הספק וחוזר ל-`https://mail.retsef.co.il/dc/callback`. שם המערכת בודקת את הדומיין ומחזירה את הלקוח למסך הדומיין.

מפתח החתימה נוצר פעם אחת ונשמר במסד הנתונים. אפשר גם לספק אותו במשתנה `DOMAIN_CONNECT_PRIVATE_KEY`.

## שלבי הרישום

### 1. פרסום המפתח הציבורי
1. במערכת, בחשבון המנהל: **ניהול חשבונות** ← **חיבור בלחיצה לספקי DNS**.
2. מעתיקים את רשומות ה-TXT שמוצגות שם (בשם `_dck1.retsef.co.il`, רשומה אחת או שתיים) ומוסיפים אותן ב-Cloudflare של `retsef.co.il`, במצב DNS only.
3. אחרי כמה דקות, ברשימת הבדיקה במסך יופיע הסעיף "מפתח החתימה מפורסם ב-DNS".

הרשומות האלה לא נוגעות ברשומות של רצף. אלה TXT בשם ייעודי.

### 2. הגשת התבניות למאגר הרשמי
1. עושים Fork למאגר https://github.com/Domain-Connect/Templates.
2. מוסיפים את שלושת הקבצים מ-`docs/domain-connect/` לשורש המאגר, בלי לשנות את שמותיהם.
3. אופציונלי: מריצים את הבודק של Domain Connect עם הדגל `-cloudflare` (`dc-template-linter -cloudflare <file>`). המאגר מריץ אותו גם אוטומטית על כל הגשה.
4. פותחים Pull Request. כותרת מוצעת: `Add retsef.co.il mailer templates (DKIM, MAIL FROM, DMARC, BIMI)`.

### 3. בקשת הפעלה מ-Cloudflare
אחרי שה-Pull Request מתקבל, שולחים מייל ל-**domain-connect@cloudflare.com**:

```
Subject: Domain Connect onboarding: retsef.co.il (mailer)

Hello,

Please onboard the following Domain Connect templates for Cloudflare DNS:

- https://github.com/Domain-Connect/Templates/blob/master/retsef.co.il.mailer.json
- https://github.com/Domain-Connect/Templates/blob/master/retsef.co.il.mailer-nodmarc.json
- https://github.com/Domain-Connect/Templates/blob/master/retsef.co.il.mailer-bimi.json

syncPubKeyDomain TXT record to query: _dck1.retsef.co.il
Logo (SVG): https://mail.retsef.co.il/app/logo.svg
Default proxy status for CNAME records: DNS only (not proxied). The CNAMEs are DKIM records and must not be proxied.

The templates add the records needed to send authenticated email through our platform (Amazon SES): three DKIM CNAMEs, a custom MAIL FROM subdomain (MX + SPF via SPFM), and optionally DMARC or BIMI TXT records. We use the synchronous flow with signed requests.

[Optional] Cloudflare account ID for testing: <account id>

Thank you,
<name>
```

אם מוסיפים את מזהה חשבון ה-Cloudflare שלכם (מופיע בלוח הבקרה של Cloudflare, בצד ימין בעמוד של כל דומיין), Cloudflare יכולים להגביל את התבנית לחשבון הזה עד שתאשרו שהיא עובדת. זו הדרך הבטוחה לבדוק לפני שזה נפתח לכל הלקוחות.

### 4. אחרי האישור
- במסך הניהול, כל תבנית מסומנת "אושרה ב-Cloudflare".
- במסך הדומיין של כל לקוח שהדומיין שלו ב-Cloudflare מופיע הכפתור **"חיבור ל-Cloudflare בלחיצה אחת"**. לא צריך לשנות קוד או הגדרות.
- Cloudflare בודקים עדכונים לתבניות כמה פעמים ביום. שינוי בקובץ במאגר מתעדכן אצלם תוך כ-8 שעות.

## ספקי DNS נוספים
אותן תבניות עובדות גם אצל ספקים אחרים שתומכים ב-Domain Connect, כמו GoDaddy, IONOS ו-Vercel. בכל ספק תהליך הרישום נפרד. המערכת מזהה את הספק לבד, ומציגה את הכפתור עם השם שלו ברגע שהוא תומך בתבנית.

## אם הדומיין של המוצר משתנה
`providerId`, `syncPubKeyDomain` וכתובת החזרה קשורים ל-`retsef.co.il` ול-`mail.retsef.co.il`. אם המוצר עובר לדומיין אחר, מעדכנים את הקבועים ב-`src/services/domainConnect.ts`, מפיקים את התבניות מחדש ומגישים שוב.
