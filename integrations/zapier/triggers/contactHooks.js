'use strict';
const { BASE_URL, contact, contactSample, contactOutputFields, listField } = require('../common');
const { subscribe, unsubscribe } = require('../hooks');

/**
 * Instant triggers on contact.* webhooks. Zapier dedupes by `id`, so list events get an id that is unique per list
 * (a contact that joins two lists triggers twice).
 */
function contactTrigger({ key, event, label, description, list, listRequired, polling }) {
  return {
    key,
    noun: 'מנוי',
    display: { label, description },
    operation: {
      type: 'hook',
      inputFields: list ? [listField({ required: !!listRequired, helpText: listRequired ? undefined : 'אפשר להשאיר ריק: כל הרשימות.' })] : [],
      performSubscribe: subscribe([event]),
      performUnsubscribe: unsubscribe,
      perform: (z, bundle) => {
        const body = bundle.cleanedRequest || {};
        const data = body.data || {};
        if (body.type && body.type !== event) return [];
        if (!data.contact) return [];
        if (list && bundle.inputData.list_id && data.list_id !== bundle.inputData.list_id) return [];
        const c = contact(data.contact);
        if (data.list_id) return [{ ...c, id: `${c.id}:${data.list_id}`, contact_id: c.id, list_id: data.list_id }];
        return [{ ...c, contact_id: c.id }];
      },
      // Used when building the Zap ("Test trigger"): the most recent matching contacts
      performList: async (z, bundle) => {
        const params = { limit: 3, ...polling(bundle) };
        const res = await z.request({ url: `${BASE_URL}/v1/contacts`, params });
        return res.data.items.map((c) => {
          const out = { ...contact(c), contact_id: c.id };
          return params.list_id ? { ...out, id: `${c.id}:${params.list_id}`, list_id: params.list_id } : out;
        });
      },
      sample: { ...contactSample, contact_id: contactSample.id },
      outputFields: [...contactOutputFields, { key: 'contact_id', label: 'מזהה איש הקשר' }],
    },
  };
}

module.exports = [
  contactTrigger({
    key: 'new_contact',
    event: 'contact.created',
    label: 'מנוי חדש',
    description: 'כשנוסף איש קשר חדש (דרך ה-API, טופס הרשמה או אפליקציה). ייבוא מרוכז של קובץ לא מפעיל את הטריגר.',
    polling: () => ({}),
  }),
  contactTrigger({
    key: 'contact_added_to_list',
    event: 'contact.added_to_list',
    label: 'מנוי נוסף לרשימה',
    description: 'כשאיש קשר מצטרף לרשימה (ובהרשמה כפולה, כשהוא מאשר).',
    list: true,
    polling: (bundle) => (bundle.inputData.list_id ? { list_id: bundle.inputData.list_id } : {}),
  }),
  contactTrigger({
    key: 'contact_unsubscribed',
    event: 'contact.unsubscribed',
    label: 'מנוי הסיר את עצמו',
    description: 'כשאיש קשר מבקש להסיר את עצמו מהדיוור (בקישור במייל או דרך ה-API).',
    polling: () => ({ status: 'unsubscribed' }),
  }),
  contactTrigger({
    key: 'contact_updated',
    event: 'contact.updated',
    label: 'פרטי מנוי עודכנו',
    description: 'כשפרטי איש קשר משתנים.',
    polling: () => ({}),
  }),
];
