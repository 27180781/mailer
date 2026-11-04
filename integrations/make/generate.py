#!/usr/bin/env python3
"""Builds the Make (make.com) custom app files. Run: python3 generate.py
Each module gets a folder with the JSON for each tab in Make's app editor."""
import json, os, shutil

BASE = 'https://mail.retsef.co.il/v1'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'app')
shutil.rmtree(OUT, ignore_errors=True)

def write(path, data):
    p = os.path.join(OUT, path)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write('\n')

# ---------- Base ----------
write('base.imljson', {
    'baseUrl': BASE,
    'headers': {'Authorization': 'Bearer {{connection.apiKey}}'},
    'response': {'error': {'type': 'RuntimeError', 'message': '[{{statusCode}}] {{body.error.message}}', '429': {'type': 'RateLimitError', 'message': '{{body.error.message}}'}}},
    'log': {'sanitize': ['request.headers.authorization']},
})

# ---------- Connection ----------
write('connection/communication.imljson', {
    'url': f'{BASE}/me',
    'headers': {'Authorization': 'Bearer {{parameters.apiKey}}'},
    'response': {
        'metadata': {'type': 'text', 'value': '{{body.account.name}}'},
        'error': {'message': '{{body.error.message}}'},
    },
    'log': {'sanitize': ['request.headers.authorization']},
})
write('connection/parameters.imljson', [
    {'name': 'apiKey', 'type': 'password', 'label': 'מפתח API', 'required': True,
     'help': 'יוצרים מפתח במערכת הדיוור, במסך **מפתחות API**. המפתח מתחיל ב-`mk_live_`, או ב-`mk_test_` לבדיקות בלי שליחה אמיתית.'},
])

# ---------- Shared pieces ----------
CONTACT_INTERFACE = [
    {'name': 'id', 'type': 'text', 'label': 'מזהה'},
    {'name': 'email', 'type': 'email', 'label': 'מייל'},
    {'name': 'name', 'type': 'text', 'label': 'שם'},
    {'name': 'status', 'type': 'text', 'label': 'סטטוס'},
    {'name': 'attributes', 'type': 'any', 'label': 'שדות נוספים'},
    {'name': 'consent_source', 'type': 'text', 'label': 'מקור ההסכמה'},
    {'name': 'lists', 'type': 'array', 'label': 'רשימות', 'spec': [
        {'name': 'id', 'type': 'text', 'label': 'מזהה'}, {'name': 'name', 'type': 'text', 'label': 'שם'}, {'name': 'status', 'type': 'text', 'label': 'סטטוס'}]},
    {'name': 'created_at', 'type': 'date', 'label': 'נוצר'},
    {'name': 'updated_at', 'type': 'date', 'label': 'עודכן'},
]
CONTACT_SAMPLE = {'id': '6f1c2a54-2b51-4d1e-9a51-1c0b8b2a7e10', 'email': 'dana@example.com', 'name': 'דנה כהן', 'status': 'active',
                  'attributes': {'city': 'חיפה'}, 'consent_source': 'טופס באתר',
                  'lists': [{'id': '0b5b3f6e-6a3c-4c0e-8f53-6a0e6c3a1f22', 'name': 'לקוחות', 'status': 'confirmed'}],
                  'created_at': '2026-11-04T10:00:00.000Z', 'updated_at': '2026-11-04T10:00:00.000Z'}
CONTACT_REF = {'name': 'contact', 'type': 'text', 'label': 'מייל או מזהה של איש הקשר', 'required': True}
LIST_SELECT = lambda name='list_id', label='רשימה', required=True, multiple=False: {
    'name': name, 'type': 'select', 'label': label, 'required': required, 'multiple': multiple, 'options': 'rpc://listLists'}
ATTRIBUTES = {'name': 'attributes', 'type': 'array', 'label': 'שדות נוספים',
              'help': 'למשל city = חיפה. אפשר להשתמש בהם בתבניות: {{city}}.',
              'spec': [{'name': 'key', 'type': 'text', 'label': 'שם השדה', 'required': True}, {'name': 'value', 'type': 'text', 'label': 'ערך'}]}
ATTR_IML = '{{if(length(parameters.attributes) > 0; toCollection(parameters.attributes; "key"; "value"); emptycollection())}}'
CONTACT_PATH = '/contacts/{{encodeURL(parameters.contact)}}'

def module(name, label, description, kind, communication, parameters=None, interface=None, samples=None, expect=None):
    """kind: action | search | instant_trigger | universal"""
    write(f'modules/{name}/meta.json', {'name': name, 'label': label, 'description': description, 'type': kind})
    write(f'modules/{name}/communication.imljson', communication)
    write(f'modules/{name}/static-parameters.imljson', parameters or [])
    write(f'modules/{name}/mappable-parameters.imljson', expect or [])
    write(f'modules/{name}/interface.imljson', interface or [])
    write(f'modules/{name}/samples.imljson', samples or {})

contact_out = {'output': '{{body}}'}

# ---------- Actions ----------
module('createOrUpdateContact', 'הוספה או עדכון של מנוי', 'מוסיף איש קשר, או מעדכן אותו אם המייל כבר קיים, ויכול לצרף אותו לרשימות.', 'action',
       {'url': '/contacts', 'method': 'POST', 'body': {
           'email': '{{parameters.email}}', 'name': '{{ifempty(parameters.name; undefined)}}',
           'attributes': ATTR_IML, 'consent_source': '{{ifempty(parameters.consent_source; undefined)}}',
           'list_ids': '{{ifempty(parameters.list_ids; emptyarray)}}'}, 'response': contact_out},
       expect=[{'name': 'email', 'type': 'email', 'label': 'מייל', 'required': True},
               {'name': 'name', 'type': 'text', 'label': 'שם'},
               LIST_SELECT('list_ids', 'רשימות', False, True),
               ATTRIBUTES,
               {'name': 'consent_source', 'type': 'text', 'label': 'מקור ההסכמה',
                'help': 'מאיפה הגיעה ההסכמה לקבל דיוור (למשל "טופס באתר"). חובה לפי חוק התקשורת כשמכניסים מנוי לרשימת דיוור.'}],
       interface=CONTACT_INTERFACE + [{'name': 'created', 'type': 'boolean', 'label': 'נוצר עכשיו'}], samples={**CONTACT_SAMPLE, 'created': True})

module('updateContact', 'עדכון פרטי מנוי', 'משנה שם, מייל או שדות של איש קשר קיים, לפי המייל או המזהה שלו.', 'action',
       {'url': CONTACT_PATH, 'method': 'PATCH', 'body': {
           'email': '{{ifempty(parameters.new_email; undefined)}}', 'name': '{{ifempty(parameters.name; undefined)}}',
           'attributes': '{{if(length(parameters.attributes) > 0; toCollection(parameters.attributes; "key"; "value"); undefined)}}'},
        'response': contact_out},
       expect=[CONTACT_REF, {'name': 'new_email', 'type': 'email', 'label': 'מייל חדש', 'help': 'רק אם הכתובת השתנתה.'},
               {'name': 'name', 'type': 'text', 'label': 'שם'}, {**ATTRIBUTES, 'help': 'מתמזגים עם השדות הקיימים.'}],
       interface=CONTACT_INTERFACE, samples=CONTACT_SAMPLE)

module('unsubscribeContact', 'הסרת מנוי מהדיוור', 'מסיר את איש הקשר מכל הדיוורים השיווקיים. מיילים תפעוליים (חשבוניות) ממשיכים להגיע.', 'action',
       {'url': CONTACT_PATH, 'method': 'PATCH', 'body': {'status': 'unsubscribed'}, 'response': contact_out},
       expect=[CONTACT_REF], interface=CONTACT_INTERFACE, samples={**CONTACT_SAMPLE, 'status': 'unsubscribed'})

module('resubscribeContact', 'החזרת מנוי שהוסר', 'מחזיר לדיוור מנוי שהסיר את עצמו, אחרי שנתן הסכמה מחדש.', 'action',
       {'url': CONTACT_PATH, 'method': 'PATCH', 'body': {'status': 'active', 'consent_source': '{{parameters.consent_source}}'}, 'response': contact_out},
       expect=[CONTACT_REF, {'name': 'consent_source', 'type': 'text', 'label': 'מקור ההסכמה החדשה', 'required': True, 'help': 'למשל "נרשם מחדש בטופס באתר".'}],
       interface=CONTACT_INTERFACE, samples=CONTACT_SAMPLE)

module('addToList', 'צירוף מנוי לרשימה', 'מצרף איש קשר קיים לרשימה.', 'action',
       {'url': CONTACT_PATH, 'method': 'PATCH', 'body': {'add_list_ids': ['{{parameters.list_id}}']}, 'response': contact_out},
       expect=[LIST_SELECT(), CONTACT_REF], interface=CONTACT_INTERFACE, samples=CONTACT_SAMPLE)

module('removeFromList', 'הוצאת מנוי מרשימה', 'מוציא איש קשר מרשימה אחת. הוא נשאר במערכת ובשאר הרשימות.', 'action',
       {'url': CONTACT_PATH, 'method': 'PATCH', 'body': {'remove_list_ids': ['{{parameters.list_id}}']}, 'response': contact_out},
       expect=[LIST_SELECT(), CONTACT_REF], interface=CONTACT_INTERFACE, samples=CONTACT_SAMPLE)

module('deleteContact', 'מחיקת מנוי', 'מוחק את איש הקשר לגמרי. כדי רק להפסיק לשלוח לו, עדיף "הסרת מנוי מהדיוור".', 'action',
       {'url': CONTACT_PATH, 'method': 'DELETE', 'response': {'output': {'ok': '{{body.ok}}', 'contact': '{{parameters.contact}}'}}},
       expect=[CONTACT_REF], interface=[{'name': 'ok', 'type': 'boolean', 'label': 'נמחק'}, {'name': 'contact', 'type': 'text', 'label': 'איש הקשר'}],
       samples={'ok': True, 'contact': 'dana@example.com'})

LIST_INTERFACE = [{'name': 'id', 'type': 'text', 'label': 'מזהה'}, {'name': 'name', 'type': 'text', 'label': 'שם'},
                  {'name': 'description', 'type': 'text', 'label': 'תיאור'}, {'name': 'double_opt_in', 'type': 'boolean', 'label': 'הרשמה כפולה'},
                  {'name': 'members', 'type': 'number', 'label': 'מנויים'}, {'name': 'created_at', 'type': 'date', 'label': 'נוצרה'}]
LIST_SAMPLE = {'id': '0b5b3f6e-6a3c-4c0e-8f53-6a0e6c3a1f22', 'name': 'לקוחות', 'description': None, 'double_opt_in': True, 'members': 120, 'created_at': '2026-11-04T10:00:00.000Z'}

module('createList', 'יצירת רשימה', 'יוצר רשימת תפוצה חדשה.', 'action',
       {'url': '/lists', 'method': 'POST', 'body': {'name': '{{parameters.name}}', 'description': '{{ifempty(parameters.description; undefined)}}',
                                                    'double_opt_in': '{{parameters.double_opt_in}}'}, 'response': {'output': '{{body}}'}},
       expect=[{'name': 'name', 'type': 'text', 'label': 'שם הרשימה', 'required': True}, {'name': 'description', 'type': 'text', 'label': 'תיאור'},
               {'name': 'double_opt_in', 'type': 'boolean', 'label': 'הרשמה כפולה בטופס', 'default': True,
                'help': 'נרשמים בטופס יקבלו מייל אישור לפני שיצורפו.'}],
       interface=LIST_INTERFACE, samples=LIST_SAMPLE)

module('sendEmail', 'שליחת מייל', 'שולח מייל מכתובת בדומיין מאומת בחשבון.', 'action',
       {'url': '/emails', 'method': 'POST',
        'headers': {'Idempotency-Key': '{{ifempty(parameters.idempotency_key; undefined)}}'},
        'body': {'from': {'email': '{{parameters.from_email}}', 'name': '{{ifempty(parameters.from_name; undefined)}}'},
                 'to': '{{parameters.to}}', 'reply_to': '{{ifempty(parameters.reply_to; undefined)}}',
                 'subject': '{{parameters.subject}}', 'html': '{{ifempty(parameters.html; undefined)}}', 'text': '{{ifempty(parameters.text; undefined)}}',
                 'type': '{{parameters.type}}',
                 'metadata': '{{if(length(parameters.metadata) > 0; toCollection(parameters.metadata; "key"; "value"); emptycollection())}}'},
        'response': {'output': {'id': '{{body.messages[1].id}}', 'status': '{{body.messages[1].status}}',
                                'message_id_header': '{{body.messages[1].message_id_header}}', 'from_email': '{{body.from_email}}',
                                'used_fallback': '{{body.used_fallback}}', 'messages': '{{body.messages}}'}}},
       expect=[{'name': 'from_email', 'type': 'email', 'label': 'כתובת השולח', 'required': True, 'help': 'כתובת בדומיין שאומת במערכת.'},
               {'name': 'from_name', 'type': 'text', 'label': 'שם השולח'},
               {'name': 'to', 'type': 'array', 'label': 'נמענים', 'required': True, 'spec': {'type': 'email', 'label': 'מייל'}, 'help': 'עד 50 כתובות.'},
               {'name': 'reply_to', 'type': 'email', 'label': 'כתובת לתשובות'},
               {'name': 'subject', 'type': 'text', 'label': 'נושא', 'required': True},
               {'name': 'html', 'type': 'text', 'label': 'תוכן (HTML)', 'multiline': True},
               {'name': 'text', 'type': 'text', 'label': 'תוכן (טקסט רגיל)', 'multiline': True},
               {'name': 'type', 'type': 'select', 'label': 'סוג', 'required': True, 'default': 'transactional', 'options': [
                   {'label': 'תפעולי (אישור הזמנה, חשבונית)', 'value': 'transactional'}, {'label': 'שיווקי (עם קישור הסרה)', 'value': 'marketing'}]},
               {'name': 'metadata', 'type': 'array', 'label': 'נתונים פנימיים', 'help': 'חוזרים אליכם באירועי המייל, למשל order_id.',
                'spec': [{'name': 'key', 'type': 'text', 'label': 'שם', 'required': True}, {'name': 'value', 'type': 'text', 'label': 'ערך'}]},
               {'name': 'idempotency_key', 'type': 'text', 'label': 'מפתח למניעת כפילות', 'help': 'אם התרחיש ירוץ שוב עם אותו מפתח, המייל לא יישלח פעמיים.'}],
       interface=[{'name': 'id', 'type': 'text', 'label': 'מזהה המייל'}, {'name': 'status', 'type': 'text', 'label': 'סטטוס'},
                  {'name': 'message_id_header', 'type': 'text', 'label': 'Message-ID'}, {'name': 'from_email', 'type': 'email', 'label': 'נשלח מ'},
                  {'name': 'used_fallback', 'type': 'boolean', 'label': 'נשלח מכתובת גיבוי'}, {'name': 'messages', 'type': 'any', 'label': 'כל ההודעות'}],
       samples={'id': 'c1b82e6c-1111-4c3a-9a51-1c0b8b2a7e10', 'status': 'queued', 'message_id_header': '<c1b82e6c@mail.example.co.il>', 'from_email': 'news@example.co.il', 'used_fallback': False})

# ---------- Searches ----------
module('getContact', 'חיפוש מנוי לפי מייל', 'מחזיר איש קשר לפי כתובת המייל. אם אין כזה, המודול לא מחזיר כלום (בלי שגיאה).', 'search',
       # The list endpoint with an exact email returns zero items instead of a 404, so "not found" is not an error
       {'url': '/contacts', 'method': 'GET', 'qs': {'email': '{{parameters.email}}', 'limit': 1}, 'response': {'iterate': '{{body.items}}', 'output': '{{item}}'}},
       expect=[{'name': 'email', 'type': 'email', 'label': 'מייל', 'required': True}],
       interface=[x for x in CONTACT_INTERFACE if x['name'] != 'lists'], samples={k: v for k, v in CONTACT_SAMPLE.items() if k != 'lists'})

module('listContacts', 'חיפוש מנויים', 'מחזיר אנשי קשר לפי טקסט, רשימה או סטטוס.', 'search',
       {'url': '/contacts', 'method': 'GET',
        'qs': {'search': '{{ifempty(parameters.search; undefined)}}', 'list_id': '{{ifempty(parameters.list_id; undefined)}}',
               'status': '{{ifempty(parameters.status; undefined)}}', 'limit': '{{ifempty(parameters.limit; 50)}}'},
        'response': {'iterate': '{{body.items}}', 'output': '{{item}}', 'limit': '{{ifempty(parameters.limit; 50)}}'}},
       expect=[{'name': 'search', 'type': 'text', 'label': 'טקסט לחיפוש', 'help': 'חלק מהמייל או מהשם.'},
               LIST_SELECT(required=False),
               {'name': 'status', 'type': 'select', 'label': 'סטטוס', 'options': [
                   {'label': 'פעיל', 'value': 'active'}, {'label': 'הוסר', 'value': 'unsubscribed'}, {'label': 'חזר (bounce)', 'value': 'bounced'}, {'label': 'סימן כספאם', 'value': 'complained'}]},
               {'name': 'limit', 'type': 'uinteger', 'label': 'כמה להחזיר לכל היותר', 'default': 50, 'validate': {'max': 500}}],
       interface=[x for x in CONTACT_INTERFACE if x['name'] != 'lists'], samples={k: v for k, v in CONTACT_SAMPLE.items() if k != 'lists'})

module('listLists', 'רשימות התפוצה', 'מחזיר את כל הרשימות בחשבון.', 'search',
       {'url': '/lists', 'method': 'GET', 'response': {'iterate': '{{body}}', 'output': '{{item}}'}},
       interface=LIST_INTERFACE, samples=LIST_SAMPLE)

# ---------- Instant triggers (webhooks) ----------
CONTACT_EVENTS = [
    ('contact.created', 'מנוי חדש'), ('contact.added_to_list', 'מנוי נוסף לרשימה'), ('contact.unsubscribed', 'מנוי הסיר את עצמו'),
    ('contact.updated', 'פרטי מנוי עודכנו'), ('contact.removed_from_list', 'מנוי הוצא מרשימה'), ('contact.deleted', 'מנוי נמחק')]
EMAIL_EVENTS = [
    ('email.sent', 'נשלח'), ('email.delivered', 'נמסר'), ('email.opened', 'נפתח'), ('email.clicked', 'לחיצה על קישור'),
    ('email.bounced', 'חזר (bounce)'), ('email.complained', 'סומן כספאם'), ('email.failed', 'נכשל'), ('email.unsubscribed', 'הסרה מהדיוור')]

def webhook(name, label, params, events_iml):
    write(f'webhooks/{name}/meta.json', {'name': name, 'label': label, 'type': 'dedicated (attached)', 'connection': 'connection'})
    write(f'webhooks/{name}/parameters.imljson', params)
    write(f'webhooks/{name}/communication.imljson', {})
    write(f'webhooks/{name}/attach.imljson', {
        'url': '/webhooks', 'method': 'POST', 'body': {'url': '{{webhook.url}}', 'events': events_iml},
        'response': {'data': {'externalHookId': '{{body.id}}'}}})
    write(f'webhooks/{name}/detach.imljson', {'url': '/webhooks/{{webhook.externalHookId}}', 'method': 'DELETE'})

webhook('contactEvents', 'אירועי מנויים',
        [{'name': 'event', 'type': 'select', 'label': 'מתי להפעיל', 'required': True, 'default': 'contact.created',
          'options': [{'label': l, 'value': v} for v, l in CONTACT_EVENTS]}],
        ['{{parameters.event}}'])
webhook('emailEvents', 'אירועי מיילים',
        [{'name': 'events', 'type': 'select', 'label': 'אירועים', 'required': True, 'multiple': True, 'default': ['email.delivered'],
          'options': [{'label': l, 'value': v} for v, l in EMAIL_EVENTS]}],
        '{{parameters.events}}')

module('watchContacts', 'אירועי מנויים', 'מפעיל את התרחיש מיד כשמנוי נוסף, מצטרף לרשימה, מסיר את עצמו ועוד. ייבוא מרוכז של קובץ לא מפעיל אותו.', 'instant_trigger',
       {'output': {'event': '{{body.type}}', 'created_at': '{{body.created_at}}', 'list_id': '{{body.data.list_id}}', 'source': '{{body.data.source}}',
                   'contact': '{{body.data.contact}}'}},
       interface=[{'name': 'event', 'type': 'text', 'label': 'סוג האירוע'}, {'name': 'created_at', 'type': 'date', 'label': 'זמן'},
                  {'name': 'list_id', 'type': 'text', 'label': 'מזהה הרשימה'}, {'name': 'source', 'type': 'text', 'label': 'מקור'},
                  {'name': 'contact', 'type': 'collection', 'label': 'איש הקשר', 'spec': [x for x in CONTACT_INTERFACE if x['name'] != 'lists']}],
       samples={'event': 'contact.created', 'created_at': '2026-11-04T10:00:00.000Z', 'list_id': None, 'source': None,
                'contact': {k: v for k, v in CONTACT_SAMPLE.items() if k != 'lists'}})
write('modules/watchContacts/meta.json', {'name': 'watchContacts', 'label': 'אירועי מנויים', 'type': 'instant_trigger', 'webhook': 'contactEvents',
                                           'description': 'מפעיל את התרחיש מיד כשמנוי נוסף, מצטרף לרשימה, מסיר את עצמו ועוד. ייבוא מרוכז של קובץ לא מפעיל אותו.'})

module('watchEmails', 'אירועי מיילים', 'מפעיל את התרחיש כשמייל נמסר, נפתח, חזר, סומן כספאם ועוד.', 'instant_trigger',
       {'output': {'event': '{{body.type}}', 'created_at': '{{body.created_at}}', 'message_id': '{{body.data.message_id}}', 'to': '{{body.data.to}}',
                   'recipient': '{{body.data.recipient}}', 'recipient_type': '{{body.data.recipient_type}}', 'campaign_id': '{{body.data.campaign_id}}',
                   'url': '{{body.data.url}}', 'bounce_type': '{{body.data.bounce_type}}', 'metadata': '{{body.data.metadata}}', 'data': '{{body.data}}'}},
       interface=[{'name': 'event', 'type': 'text', 'label': 'סוג האירוע'}, {'name': 'created_at', 'type': 'date', 'label': 'זמן'},
                  {'name': 'message_id', 'type': 'text', 'label': 'מזהה המייל'}, {'name': 'to', 'type': 'email', 'label': 'נשלח אל'},
                  {'name': 'recipient', 'type': 'email', 'label': 'נמען'}, {'name': 'recipient_type', 'type': 'text', 'label': 'סוג נמען'},
                  {'name': 'campaign_id', 'type': 'text', 'label': 'מזהה הדיוור'}, {'name': 'url', 'type': 'url', 'label': 'הקישור שנלחץ'},
                  {'name': 'bounce_type', 'type': 'text', 'label': 'סוג החזרה'}, {'name': 'metadata', 'type': 'any', 'label': 'נתונים פנימיים'},
                  {'name': 'data', 'type': 'any', 'label': 'כל הנתונים'}],
       samples={'event': 'email.delivered', 'created_at': '2026-11-04T10:00:00.000Z', 'message_id': 'c1b82e6c-1111-4c3a-9a51-1c0b8b2a7e10',
                'to': 'dana@example.com', 'recipient': 'dana@example.com', 'recipient_type': 'to', 'metadata': {'order_id': '1234'}})
write('modules/watchEmails/meta.json', {'name': 'watchEmails', 'label': 'אירועי מיילים', 'type': 'instant_trigger', 'webhook': 'emailEvents',
                                         'description': 'מפעיל את התרחיש כשמייל נמסר, נפתח, חזר, סומן כספאם ועוד.'})

# ---------- Universal ----------
module('makeApiCall', 'קריאת API חופשית', 'קריאה לכל נתיב ב-API של מערכת הדיוור, עם החיבור הקיים.', 'universal',
       {'url': '{{parameters.url}}', 'method': '{{parameters.method}}', 'headers': '{{toCollection(parameters.headers; "key"; "value")}}',
        'qs': '{{toCollection(parameters.qs; "key"; "value")}}', 'body': '{{parameters.body}}',
        'response': {'output': {'body': '{{body}}', 'headers': '{{headers}}', 'statusCode': '{{statusCode}}'}}},
       expect=[{'name': 'url', 'type': 'text', 'label': 'נתיב', 'required': True, 'help': 'למשל `/contacts`. כתובת הבסיס היא ' + BASE},
               {'name': 'method', 'type': 'select', 'label': 'שיטה', 'required': True, 'default': 'GET',
                'options': [{'label': m, 'value': m} for m in ['GET', 'POST', 'PATCH', 'PUT', 'DELETE']]},
               {'name': 'headers', 'type': 'array', 'label': 'כותרות', 'spec': [{'name': 'key', 'type': 'text', 'label': 'שם'}, {'name': 'value', 'type': 'text', 'label': 'ערך'}]},
               {'name': 'qs', 'type': 'array', 'label': 'פרמטרים בכתובת', 'spec': [{'name': 'key', 'type': 'text', 'label': 'שם'}, {'name': 'value', 'type': 'text', 'label': 'ערך'}]},
               {'name': 'body', 'type': 'any', 'label': 'גוף הבקשה (JSON)'}],
       interface=[{'name': 'body', 'type': 'any', 'label': 'תשובה'}, {'name': 'headers', 'type': 'collection', 'label': 'כותרות'},
                  {'name': 'statusCode', 'type': 'number', 'label': 'קוד'}])

# ---------- RPC ----------
write('rpcs/listLists/meta.json', {'name': 'listLists', 'label': 'רשימות התפוצה'})
write('rpcs/listLists/communication.imljson', {'url': '/lists', 'method': 'GET',
                                               'response': {'iterate': '{{body}}', 'output': {'label': '{{item.name}}', 'value': '{{item.id}}'}}})
write('rpcs/listLists/parameters.imljson', [])

print('wrote', OUT)
