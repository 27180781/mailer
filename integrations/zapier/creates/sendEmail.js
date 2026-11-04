'use strict';
const { BASE_URL, emails, dict } = require('../common');

module.exports = {
  key: 'send_email',
  noun: 'מייל',
  display: { label: 'שליחת מייל', description: 'שולח מייל מכתובת בדומיין מאומת בחשבון.' },
  operation: {
    inputFields: [
      { key: 'from_email', label: 'כתובת השולח', required: true, helpText: 'כתובת בדומיין שאומת במערכת, למשל news@yourdomain.co.il.' },
      { key: 'from_name', label: 'שם השולח' },
      { key: 'to', label: 'נמענים', required: true, list: true, helpText: 'עד 50 כתובות.' },
      { key: 'reply_to', label: 'כתובת לתשובות' },
      { key: 'subject', label: 'נושא', required: true },
      { key: 'html', label: 'תוכן (HTML)', type: 'text', helpText: 'תוכן המייל. אם אין HTML, ממלאים טקסט רגיל.' },
      { key: 'text', label: 'תוכן (טקסט רגיל)', type: 'text' },
      {
        key: 'type',
        label: 'סוג',
        choices: { transactional: 'תפעולי (אישור הזמנה, חשבונית)', marketing: 'שיווקי (עם קישור הסרה)' },
        default: 'transactional',
        required: true,
      },
      { key: 'metadata', label: 'נתונים פנימיים', dict: true, helpText: 'חוזרים אליכם באירועים (webhooks) של המייל, למשל order_id.' },
      { key: 'idempotency_key', label: 'מפתח למניעת כפילות', helpText: 'אם Zapier ינסה שוב עם אותו מפתח, המייל לא יישלח פעמיים.' },
    ],
    perform: async (z, b) => {
      const d = b.inputData;
      const res = await z.request({
        method: 'POST',
        url: `${BASE_URL}/v1/emails`,
        headers: d.idempotency_key ? { 'Idempotency-Key': d.idempotency_key } : {},
        body: {
          from: { email: d.from_email, name: d.from_name || undefined },
          to: emails(d.to),
          reply_to: d.reply_to || undefined,
          subject: d.subject,
          html: d.html || undefined,
          text: d.text || undefined,
          type: d.type || 'transactional',
          metadata: dict(d.metadata),
        },
      });
      const m = (res.data.messages || [])[0] || {};
      return { id: m.id, status: m.status, message_id_header: m.message_id_header, from_email: res.data.from_email, messages: res.data.messages };
    },
    sample: { id: 'c1b82e6c-1111-4c3a-9a51-1c0b8b2a7e10', status: 'queued', message_id_header: '<c1b82e6c@mail.example.co.il>', from_email: 'news@example.co.il' },
  },
};
