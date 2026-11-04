'use strict';
const { BASE_URL } = require('../common');
const { subscribe, unsubscribe } = require('../hooks');

const EVENTS = {
  'email.sent': 'נשלח',
  'email.delivered': 'נמסר',
  'email.opened': 'נפתח',
  'email.clicked': 'לחיצה על קישור',
  'email.bounced': 'חזר (bounce)',
  'email.complained': 'סומן כספאם',
  'email.failed': 'נכשל',
  'email.unsubscribed': 'הסרה מהדיוור',
};

module.exports = {
  key: 'email_event',
  noun: 'אירוע מייל',
  display: { label: 'אירוע במייל', description: 'כשמייל נמסר, נפתח, חזר, סומן כספאם ועוד.' },
  operation: {
    type: 'hook',
    inputFields: [
      { key: 'events', label: 'אירועים', required: true, list: true, choices: EVENTS, default: 'email.delivered' },
    ],
    performSubscribe: async (z, bundle) => {
      const events = [].concat(bundle.inputData.events || []).filter((e) => EVENTS[e]);
      return subscribe(events.length ? events : ['email.delivered'])(z, bundle);
    },
    performUnsubscribe: unsubscribe,
    perform: (z, bundle) => {
      const b = bundle.cleanedRequest || {};
      if (!b.type || !b.data) return [];
      const d = b.data;
      return [
        {
          id: `${d.message_id}:${b.type}:${d.recipient || d.to}:${b.created_at}`,
          event: b.type,
          event_label: EVENTS[b.type] || b.type,
          created_at: b.created_at,
          ...d,
        },
      ];
    },
    performList: async (z) => {
      const res = await z.request({ url: `${BASE_URL}/v1/emails`, params: { limit: 3 } });
      return res.data.map((m) => ({
        id: `${m.id}:sample`,
        event: 'email.delivered',
        event_label: EVENTS['email.delivered'],
        created_at: m.sent_at || m.created_at,
        message_id: m.id,
        to: m.to_email,
        recipient: m.to_email,
        recipient_type: 'to',
        subject: m.subject,
        metadata: m.metadata,
      }));
    },
    sample: {
      id: 'a1b2:email.delivered:dana@example.com:2026-11-04T10:00:00.000Z',
      event: 'email.delivered',
      event_label: 'נמסר',
      created_at: '2026-11-04T10:00:00.000Z',
      message_id: 'c1b82e6c-1111-4c3a-9a51-1c0b8b2a7e10',
      to: 'dana@example.com',
      recipient: 'dana@example.com',
      recipient_type: 'to',
      metadata: { order_id: '1234' },
    },
    outputFields: [
      { key: 'event', label: 'סוג האירוע' },
      { key: 'message_id', label: 'מזהה המייל' },
      { key: 'recipient', label: 'נמען' },
      { key: 'created_at', label: 'זמן', type: 'datetime' },
    ],
  },
};
