'use strict';
/**
 * Runs the app against a real mailer server.
 *   BASE_URL=http://127.0.0.1:3000 MAILER_API_KEY=mk_test_... npm test
 * Skipped when MAILER_API_KEY is not set. Use a test key (mk_test_) so nothing is really sent.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const zapier = require('zapier-platform-core');

const key = process.env.MAILER_API_KEY;
const App = require('../index');
const appTester = zapier.createAppTester(App);
const authData = { api_key: key };
const email = `zapier-${Date.now()}@example.com`;

test('Zapier app against a mailer server', { skip: !key && 'MAILER_API_KEY not set' }, async () => {
  await appTester(App.authentication.test, { authData });

  const list = await appTester(App.creates.create_list.operation.perform, { authData, inputData: { name: `Zapier ${Date.now()}`, double_opt_in: 'false' } });
  const lists = await appTester(App.triggers.list.operation.perform, { authData });
  assert.ok(lists.some((l) => l.id === list.id));

  const c = await appTester(App.creates.create_or_update_contact.operation.perform, {
    authData,
    inputData: { email, name: 'דנה', list_ids: [list.id], attributes: { city: 'חיפה', '': 'x' }, consent_source: 'בדיקה' },
  });
  assert.equal(c.created, true);
  assert.equal(c.lists, list.name);

  const found = await appTester(App.searches.find_contact.operation.perform, { authData, inputData: { email: email.toUpperCase() } });
  assert.equal(found[0].id, c.id);
  assert.deepEqual(await appTester(App.searches.find_contact.operation.perform, { authData, inputData: { email: 'nobody-here@example.com' } }), []);

  const upd = await appTester(App.creates.update_contact.operation.perform, { authData, inputData: { contact: email, name: 'דנה כהן', attributes: { plan: 'pro' } } });
  assert.equal(upd.name, 'דנה כהן');
  assert.deepEqual(upd.attributes, { city: 'חיפה', plan: 'pro' });

  const out = await appTester(App.creates.remove_from_list.operation.perform, { authData, inputData: { contact: email, list_id: list.id } });
  assert.equal(out.lists, '');
  const back = await appTester(App.creates.add_to_list.operation.perform, { authData, inputData: { contact: c.id, list_id: list.id } });
  assert.deepEqual(back.list_ids, [list.id]);

  const un = await appTester(App.creates.unsubscribe_contact.operation.perform, { authData, inputData: { contact: email } });
  assert.equal(un.status, 'unsubscribed');
  await assert.rejects(
    appTester(App.creates.resubscribe_contact.operation.perform, { authData, inputData: { contact: email, consent_source: 'x' } }),
    /consent_source/,
    'Hebrew API error is shown to the user',
  );
  const re = await appTester(App.creates.resubscribe_contact.operation.perform, { authData, inputData: { contact: email, consent_source: 'נרשם מחדש' } });
  assert.equal(re.status, 'active');

  // REST hook: subscribe, deliver, unsubscribe
  const sub = await appTester(App.triggers.new_contact.operation.performSubscribe, { authData, targetUrl: 'https://hooks.zapier.com/hooks/standard/1/abc/' });
  assert.deepEqual(sub.events, ['contact.created']);
  const items = await appTester(App.triggers.new_contact.operation.perform, {
    authData,
    cleanedRequest: { type: 'contact.created', created_at: new Date().toISOString(), data: { contact: { id: c.id, email, status: 'active' } } },
  });
  assert.equal(items[0].email, email);
  const listed = await appTester(App.triggers.contact_added_to_list.operation.performList, { authData, inputData: { list_id: list.id } });
  assert.equal(listed[0].id, `${c.id}:${list.id}`);
  const filtered = await appTester(App.triggers.contact_added_to_list.operation.perform, {
    authData,
    inputData: { list_id: list.id },
    cleanedRequest: { type: 'contact.added_to_list', data: { contact: { id: c.id, email }, list_id: 'other-list' } },
  });
  assert.deepEqual(filtered, [], 'other lists are filtered out');
  await appTester(App.triggers.new_contact.operation.performUnsubscribe, { authData, subscribeData: sub });

  const del = await appTester(App.creates.delete_contact.operation.perform, { authData, inputData: { contact: email } });
  assert.equal(del.ok, true);
});
