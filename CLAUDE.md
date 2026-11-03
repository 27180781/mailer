# הוראות לעבודה במאגר

- **תמיד לענות למשתמש בעברית בלבד**, בכל הודעה, כולל הודעות קצרות ועדכוני ביניים. שמות קבצים, פקודות וקוד נשארים כמו שהם.
- מערכת דיוור מרובת חשבונות (Node.js, TypeScript, PostgreSQL). השליחה דרך Amazon SES בחשבון ה-AWS של רצף (010569743794, אזור il-central-1). ההגדרות: docs/aws-ses-setup.md.
- פריסה: push ל-main מריץ בדיקות ופורס ל-CapRover (https://captain.caprover.clicker.co.il, אפליקציה mailer). הכתובת החיה: https://mail.retsef.co.il.
- הדומיין retsef.co.il שמור (RESERVED_DOMAINS): ה-identity שלו ב-SES שייך לרצף, ואסור לגעת בו.
- בדיקות: `TEST_DATABASE_URL=postgres://... npm test`
