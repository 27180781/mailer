# אפליקציית Make

אפליקציה מותאמת (Custom App) שמחברת את מערכת הדיוור ל-Make. ההתחברות במפתח API, וה-triggers מיידיים: Make רושם webhook במערכת כשמפעילים תרחיש, ומוחק אותו כשמוחקים את ה-webhook.

הקבצים בתיקייה `app/` נוצרים מ-`generate.py`. אחרי שינוי מריצים `python3 generate.py`, ולא עורכים את הקבצים ביד.

## מה יש בה

| מודול | סוג | מה עושה |
| --- | --- | --- |
| אירועי מנויים (`watchContacts`) | Instant trigger | מנוי חדש, נוסף לרשימה, הסיר את עצמו, עודכן, הוצא מרשימה, נמחק |
| אירועי מיילים (`watchEmails`) | Instant trigger | נשלח, נמסר, נפתח, לחיצה, חזר, ספאם, נכשל, הסרה |
| הוספה או עדכון של מנוי | Action | לפי המייל, כולל רשימות ושדות נוספים |
| עדכון פרטי מנוי | Action | שם, מייל, שדות |
| הסרת מנוי מהדיוור / החזרת מנוי שהוסר | Action | |
| צירוף לרשימה / הוצאה מרשימה | Action | |
| מחיקת מנוי, יצירת רשימה, שליחת מייל | Action | |
| חיפוש מנוי לפי מייל, חיפוש מנויים, רשימות התפוצה | Search | |
| קריאת API חופשית (`makeApiCall`) | Universal | כל נתיב ב-API |

## הקמה ב-Make (פעם אחת)

1. ב-Make, בתפריט השמאלי: **Custom Apps** → **Create a new app**. ‏Name: ‏`retzef-mailer`, ‏Label: ‏`Retzef Mailer`, ‏Language: ‏Hebrew, ‏Audience: ‏Global.
2. **Base:** מדביקים את `app/base.imljson`.
3. **Connections** → Create: ‏Label "Retzef Mailer", ‏Type: ‏**API Key**. בלשונית Communication מדביקים את `app/connection/communication.imljson`, ובלשונית Parameters את `app/connection/parameters.imljson`.
4. **Webhooks** → Create, פעמיים: ‏`contactEvents` ו-`emailEvents`. ‏Type: ‏**Dedicated**, ‏Connection: זה מסעיף 3. לכל אחד מדביקים את `parameters`, ‏`attach`, ‏`detach` ו-`communication` מהתיקייה שלו ב-`app/webhooks/`.
5. **Remote procedures** → Create: ‏`listLists`, עם Connection. מדביקים את `communication` ואת `parameters` מ-`app/rpcs/listLists/`.
6. **Modules** → Create, אחד לכל תיקייה ב-`app/modules/`:
   - השם, התווית, התיאור והסוג נמצאים ב-`meta.json`. לסוגים: ‏`action` = ‏Action, ‏`search` = ‏Search, ‏`instant_trigger` = ‏Instant trigger (בוחרים את ה-webhook שכתוב ב-`meta.json`), ‏`universal` = ‏Universal (REST).
   - מדביקים את `communication`, ‏`static-parameters`, ‏`mappable-parameters`, ‏`interface` ו-`samples` בלשוניות באותו שם.

אפשר גם לעבוד מ-VS Code, עם התוסף **Make Apps Editor**, ולהדביק את אותם קבצים.

## בדיקה

לפני השיתוף בונים תרחיש קצר, ומוודאים שכל פעולה עובדת:
- **חיבור:** מחברים עם מפתח בדיקה (`mk_test_`).
- **הוספת מנוי:** מריצים "הוספה או עדכון של מנוי" עם שדות נוספים.
- **מנוי חדש:** מוסיפים trigger של "אירועי מנויים" על "מנוי חדש", ומוסיפים מנוי מהממשק של מערכת הדיוור.

הפונקציות `toCollection`, ‏`ifempty` ו-`undefined` משמשות להמרת השדות הנוספים ולהשמטת שדות ריקים. ה-API עצמו מתעלם משדות ריקים, אז גם בלעדיהן לא יישמר ערך ריק.

## שיתוף

אפליקציה מותאמת פרטית לארגון שלכם ב-Make. כדי לתת ללקוחות: בעמוד האפליקציה לוחצים **Invite** ושולחים להם את הקישור. כדי שתופיע לכל משתמשי Make, מבקשים מ-Make לבדוק ולפרסם אותה (Publish → Request review).
