'use strict';
const { BASE_URL, contact, contactSample, contactOutputFields } = require('../common');

module.exports = {
  key: 'find_contact',
  noun: 'מנוי',
  display: { label: 'חיפוש מנוי', description: 'מוצא איש קשר לפי כתובת המייל.' },
  operation: {
    inputFields: [{ key: 'email', label: 'מייל', required: true }],
    perform: async (z, b) => {
      const res = await z.request({ url: `${BASE_URL}/v1/contacts/${encodeURIComponent(b.inputData.email.trim())}`, skipThrowForStatus: true });
      if (res.status === 404) return [];
      if (res.status >= 400) res.throwForStatus();
      return [contact(res.data)];
    },
    sample: contactSample,
    outputFields: contactOutputFields,
  },
};
