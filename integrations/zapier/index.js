'use strict';
const authentication = require('./authentication');
const { addAuth, handleErrors } = require('./hooks');
const list = require('./triggers/list');
const contactTriggers = require('./triggers/contactHooks');
const emailEvent = require('./triggers/emailEvent');
const contactCreates = require('./creates/contacts');
const sendEmail = require('./creates/sendEmail');
const findContact = require('./searches/findContact');

const byKey = (items) => Object.fromEntries(items.map((i) => [i.key, i]));

module.exports = {
  version: require('./package.json').version,
  platformVersion: require('zapier-platform-core').version,
  authentication,
  beforeRequest: [addAuth],
  afterResponse: [handleErrors],
  triggers: byKey([list, ...contactTriggers, emailEvent]),
  creates: byKey([...contactCreates, sendEmail]),
  searches: byKey([findContact]),
  searchOrCreates: {
    find_contact: {
      key: 'find_contact',
      display: { label: 'חיפוש או יצירה של מנוי', description: 'מוצא איש קשר לפי המייל, ואם אין כזה, יוצר אותו.' },
      search: 'find_contact',
      create: 'create_or_update_contact',
    },
  },
};
