'use strict';

/** The mailer's address. Change it here (or set BASE_URL in `zapier env:set`) if the system moves. */
const BASE_URL = (process.env.BASE_URL || 'https://mail.retsef.co.il').replace(/\/$/, '');

/** Turns a Zapier key/value "dict" field into an object, dropping empty keys. */
const dict = (v) => Object.fromEntries(Object.entries(v || {}).filter(([k]) => k && k.trim()));

/** Splits "a@b.com, c@d.com" or a Zapier line-item array into an array of addresses. */
const emails = (v) =>
  (Array.isArray(v) ? v : String(v || '').split(/[,;\n]/))
    .map((e) => String(e).trim())
    .filter(Boolean);

/** Flattens a contact so its fields can be mapped in later Zap steps. */
const contact = (c) => ({
  id: c.id,
  email: c.email,
  name: c.name || '',
  status: c.status,
  attributes: c.attributes || {},
  consent_source: c.consent_source || '',
  lists: (c.lists || []).map((l) => l.name).join(', '),
  list_ids: (c.lists || []).map((l) => l.id),
  created_at: c.created_at,
  updated_at: c.updated_at,
});

const contactSample = {
  id: '6f1c2a54-2b51-4d1e-9a51-1c0b8b2a7e10',
  email: 'dana@example.com',
  name: 'דנה כהן',
  status: 'active',
  attributes: { city: 'חיפה' },
  consent_source: 'טופס באתר',
  lists: 'לקוחות',
  list_ids: ['0b5b3f6e-6a3c-4c0e-8f53-6a0e6c3a1f22'],
  created_at: '2026-11-04T10:00:00.000Z',
  updated_at: '2026-11-04T10:00:00.000Z',
};

const contactOutputFields = [
  { key: 'id', label: 'מזהה' },
  { key: 'email', label: 'מייל' },
  { key: 'name', label: 'שם' },
  { key: 'status', label: 'סטטוס' },
  { key: 'lists', label: 'רשימות' },
  { key: 'created_at', label: 'נוצר', type: 'datetime' },
];

/** Dynamic dropdown of the account's lists */
const listField = (extra = {}) => ({ key: 'list_id', label: 'רשימה', dynamic: 'list.id.name', ...extra });

/** Who to act on: id or email both work in the API path */
const contactRef = { key: 'contact', label: 'מייל או מזהה של איש הקשר', required: true, helpText: 'כתובת המייל של המנוי, או המזהה שלו במערכת.' };

module.exports = { BASE_URL, dict, emails, contact, contactSample, contactOutputFields, listField, contactRef };
