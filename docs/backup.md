# גיבוי יומי ל-Cloudflare R2

המערכת מגבה את כל מסד הנתונים פעם ביום: חשבונות, משתמשים, דומיינים, אנשי קשר, רשימות, דיוורים, היסטוריית מיילים ו-webhooks.
הגיבוי מוצפן לפני שהוא יוצא מהשרת, ונשמר בדלי ב-Cloudflare R2.

- **מתי:** פעם ביום, אחרי 03:00 לפי שעון ישראל (`BACKUP_HOUR`). אם גיבוי נכשל, המערכת מנסה שוב אחרי שעה.
- **מה נשמר:** `pg_dump` בפורמט custom, דחוס ב-gzip ומוצפן ב-AES-256-GCM, עם מפתח שנגזר מ-`BACKUP_PASSPHRASE`.
- **שם הקובץ:** `backups/<תאריך>/mailer-<זמן>.dump.gz.mlbk`.
- **שמירה:** 30 יום (`BACKUP_RETENTION_DAYS`). גיבויים ישנים יותר נמחקים אוטומטית.
- **מעקב:** במסך **ניהול חשבונות** ← **גיבויים** רואים את הגיבוי האחרון ואת רשימת הגיבויים, ויש כפתור "גיבוי עכשיו".

## הקמה

### 1. מפתח גישה לדלי ב-Cloudflare
1. ב-Cloudflare: **R2 Object Storage** ← **Manage API tokens** (או API Tokens בתוך R2) ← **Create API token**.
2. **Permissions:** Object Read & Write.
3. **Specify bucket:** רק הדלי של הגיבויים.
4. **Create** ← מעתיקים את **Access Key ID**, את **Secret Access Key** ואת כתובת ה-**S3 endpoint** (`https://<account-id>.r2.cloudflarestorage.com`).

### 2. משתני סביבה ב-CapRover
ב-CapRover ← `mailer` ← App Configs:

```
BACKUP_S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
BACKUP_S3_BUCKET=<שם הדלי>
BACKUP_S3_ACCESS_KEY_ID=<Access Key ID>
BACKUP_S3_SECRET_ACCESS_KEY=<Secret Access Key>
BACKUP_PASSPHRASE=<סיסמה ארוכה ואקראית, לפחות 30 תווים>
```

אופציונלי: `BACKUP_HOUR=3`, `BACKUP_RETENTION_DAYS=30`.

**את `BACKUP_PASSPHRASE` שומרים גם מחוץ למערכת**, למשל במנהל סיסמאות. בלי הסיסמה הזו אי אפשר לפתוח אף גיבוי, גם אם השרת כולו אבד.

### 3. בדיקה
אחרי Save & Update: **ניהול חשבונות** ← **גיבויים** ← **גיבוי עכשיו**. אמור להופיע "הגיבוי האחרון הצליח", והקובץ אמור להופיע גם בדלי ב-Cloudflare.

## שחזור

השחזור רץ מתוך הקונטיינר של האפליקציה, שבו כבר מותקנים `pg_dump` ו-`pg_restore` וכל משתני הסביבה.

ב-CapRover אפשר להתחבר לקונטיינר דרך השרת: `docker exec -it $(docker ps -q -f name=srv-captain--mailer) sh`.

1. רשימת הגיבויים:
   ```bash
   node dist/main.js backup-list
   ```
2. הורדה ופענוח של גיבוי לקובץ:
   ```bash
   node dist/main.js backup-download backups/2026-11-05/mailer-....dump.gz.mlbk /tmp/restore.dump
   ```
3. שחזור למסד הנתונים. **הפקודה מחליפה את התוכן הקיים:**
   ```bash
   pg_restore --clean --if-exists --no-owner --dbname "$DATABASE_URL" /tmp/restore.dump
   ```
4. מפעילים מחדש את האפליקציה ב-CapRover.

כדי לבדוק גיבוי בלי לגעת במסד הנתונים הפעיל: `pg_restore --list /tmp/restore.dump`. הפקודה מציגה את תוכן הגיבוי בלי לשחזר.

שחזור למסד נפרד, למשל לצורך בדיקה: יוצרים מסד ריק ומריצים `pg_restore` עם הכתובת שלו במקום `$DATABASE_URL`.

## גיבוי ידני
```bash
node dist/main.js backup
```
