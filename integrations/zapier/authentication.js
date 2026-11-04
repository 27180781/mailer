'use strict';
const { BASE_URL } = require('./common');

module.exports = {
  type: 'custom',
  fields: [
    {
      key: 'api_key',
      label: 'מפתח API',
      required: true,
      type: 'password',
      helpText: 'יוצרים מפתח במערכת הדיוור, במסך **מפתחות API**. המפתח מתחיל ב-`mk_live_` (או `mk_test_` לבדיקות בלי שליחה אמיתית).',
    },
  ],
  test: { url: `${BASE_URL}/v1/me` },
  connectionLabel: '{{account.name}}',
};
