'use strict';
const { BASE_URL, dict, contact, contactSample, contactOutputFields, listField, contactRef } = require('../common');

const enc = encodeURIComponent;
const out = { sample: contactSample, outputFields: contactOutputFields };

const createOrUpdate = {
  key: 'create_or_update_contact',
  noun: 'מנוי',
  display: {
    label: 'הוספה או עדכון של מנוי',
    description: 'מוסיף איש קשר, או מעדכן אותו אם המייל כבר קיים, ויכול לצרף אותו לרשימות.',
  },
  operation: {
    inputFields: [
      { key: 'email', label: 'מייל', required: true },
      { key: 'name', label: 'שם' },
      listField({ key: 'list_ids', label: 'רשימות', list: true, helpText: 'הרשימות שאליהן יצורף המנוי.' }),
      { key: 'attributes', label: 'שדות נוספים', dict: true, helpText: 'למשל city = חיפה. אפשר להשתמש בהם בתבניות: {{city}}.' },
      {
        key: 'consent_source',
        label: 'מקור ההסכמה',
        helpText: 'מאיפה הגיעה ההסכמה לקבל דיוור (למשל "טופס באתר"). חובה לפי חוק התקשורת כשמכניסים מנוי לרשימת דיוור.',
      },
    ],
    perform: async (z, b) => {
      const d = b.inputData;
      const res = await z.request({
        method: 'POST',
        url: `${BASE_URL}/v1/contacts`,
        body: {
          email: d.email,
          name: d.name || undefined,
          attributes: dict(d.attributes),
          consent_source: d.consent_source || undefined,
          list_ids: [].concat(d.list_ids || []).filter(Boolean),
        },
      });
      return { ...contact(res.data), created: res.data.created };
    },
    ...out,
  },
};

const update = {
  key: 'update_contact',
  noun: 'מנוי',
  display: { label: 'עדכון פרטי מנוי', description: 'משנה שם, מייל או שדות של איש קשר קיים, לפי המייל או המזהה שלו.' },
  operation: {
    inputFields: [
      contactRef,
      { key: 'new_email', label: 'מייל חדש', helpText: 'רק אם הכתובת השתנתה.' },
      { key: 'name', label: 'שם' },
      { key: 'attributes', label: 'שדות נוספים', dict: true, helpText: 'מתמזגים עם השדות הקיימים.' },
    ],
    perform: async (z, b) => {
      const d = b.inputData;
      const body = { attributes: Object.keys(dict(d.attributes)).length ? dict(d.attributes) : undefined };
      if (d.new_email) body.email = d.new_email;
      if (d.name) body.name = d.name;
      const res = await z.request({ method: 'PATCH', url: `${BASE_URL}/v1/contacts/${enc(d.contact)}`, body });
      return contact(res.data);
    },
    ...out,
  },
};

const unsubscribeContact = {
  key: 'unsubscribe_contact',
  noun: 'מנוי',
  display: { label: 'הסרת מנוי מהדיוור', description: 'מסיר את איש הקשר מכל הדיוורים השיווקיים. מיילים תפעוליים (חשבוניות) ממשיכים להגיע.' },
  operation: {
    inputFields: [contactRef],
    perform: async (z, b) => {
      const res = await z.request({ method: 'PATCH', url: `${BASE_URL}/v1/contacts/${enc(b.inputData.contact)}`, body: { status: 'unsubscribed' } });
      return contact(res.data);
    },
    ...out,
  },
};

const resubscribe = {
  key: 'resubscribe_contact',
  noun: 'מנוי',
  display: { label: 'החזרת מנוי שהוסר', description: 'מחזיר לדיוור מנוי שהסיר את עצמו, אחרי שנתן הסכמה מחדש.' },
  operation: {
    inputFields: [contactRef, { key: 'consent_source', label: 'מקור ההסכמה החדשה', required: true, helpText: 'למשל "נרשם מחדש בטופס באתר".' }],
    perform: async (z, b) => {
      const res = await z.request({
        method: 'PATCH',
        url: `${BASE_URL}/v1/contacts/${enc(b.inputData.contact)}`,
        body: { status: 'active', consent_source: b.inputData.consent_source },
      });
      return contact(res.data);
    },
    ...out,
  },
};

const addToList = {
  key: 'add_to_list',
  noun: 'מנוי',
  display: { label: 'צירוף מנוי לרשימה', description: 'מצרף איש קשר קיים לרשימה. כדי ליצור מנוי חדש ולצרף אותו, השתמשו ב"הוספה או עדכון של מנוי".' },
  operation: {
    inputFields: [listField({ required: true }), contactRef],
    perform: async (z, b) => {
      const res = await z.request({ method: 'PATCH', url: `${BASE_URL}/v1/contacts/${enc(b.inputData.contact)}`, body: { add_list_ids: [b.inputData.list_id] } });
      return contact(res.data);
    },
    ...out,
  },
};

const removeFromList = {
  key: 'remove_from_list',
  noun: 'מנוי',
  display: { label: 'הוצאת מנוי מרשימה', description: 'מוציא איש קשר מרשימה אחת. הוא נשאר במערכת ובשאר הרשימות.' },
  operation: {
    inputFields: [listField({ required: true }), contactRef],
    perform: async (z, b) => {
      const res = await z.request({ method: 'PATCH', url: `${BASE_URL}/v1/contacts/${enc(b.inputData.contact)}`, body: { remove_list_ids: [b.inputData.list_id] } });
      return contact(res.data);
    },
    ...out,
  },
};

const remove = {
  key: 'delete_contact',
  noun: 'מנוי',
  display: { label: 'מחיקת מנוי', description: 'מוחק את איש הקשר לגמרי. אם רוצים רק להפסיק לשלוח לו, עדיף "הסרת מנוי מהדיוור".' },
  operation: {
    inputFields: [contactRef],
    perform: async (z, b) => {
      const res = await z.request({ method: 'DELETE', url: `${BASE_URL}/v1/contacts/${enc(b.inputData.contact)}` });
      return { ok: res.data.ok, contact: b.inputData.contact };
    },
    sample: { ok: true, contact: 'dana@example.com' },
  },
};

const createList = {
  key: 'create_list',
  noun: 'רשימה',
  display: { label: 'יצירת רשימה', description: 'יוצר רשימת תפוצה חדשה.' },
  operation: {
    inputFields: [
      { key: 'name', label: 'שם הרשימה', required: true },
      { key: 'description', label: 'תיאור' },
      { key: 'double_opt_in', label: 'הרשמה כפולה בטופס', type: 'boolean', default: 'true', helpText: 'נרשמים בטופס יקבלו מייל אישור לפני שיצורפו.' },
    ],
    perform: async (z, b) => {
      const d = b.inputData;
      const res = await z.request({
        method: 'POST',
        url: `${BASE_URL}/v1/lists`,
        body: { name: d.name, description: d.description || undefined, double_opt_in: String(d.double_opt_in) !== 'false' },
      });
      return res.data;
    },
    sample: { id: '0b5b3f6e-6a3c-4c0e-8f53-6a0e6c3a1f22', name: 'לקוחות', description: null, double_opt_in: true },
  },
};

module.exports = [createOrUpdate, update, unsubscribeContact, resubscribe, addToList, removeFromList, remove, createList];
