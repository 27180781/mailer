'use strict';
const { BASE_URL } = require('../common');

/** Hidden trigger that feeds the "list" dropdowns */
module.exports = {
  key: 'list',
  noun: 'רשימה',
  display: { label: 'רשימות', description: 'רשימות התפוצה בחשבון.', hidden: true },
  operation: {
    perform: async (z) => {
      const res = await z.request({ url: `${BASE_URL}/v1/lists` });
      return res.data.map((l) => ({ id: l.id, name: l.name, members: l.members }));
    },
    sample: { id: '0b5b3f6e-6a3c-4c0e-8f53-6a0e6c3a1f22', name: 'לקוחות', members: 120 },
  },
};
