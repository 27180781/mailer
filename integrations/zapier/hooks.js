'use strict';
const { BASE_URL } = require('./common');

/** Every request carries the API key */
const addAuth = (request, z, bundle) => {
  if (bundle.authData && bundle.authData.api_key) request.headers.Authorization = `Bearer ${bundle.authData.api_key}`;
  request.headers['Content-Type'] = request.headers['Content-Type'] || 'application/json';
  request.headers.Accept = 'application/json';
  return request;
};

/** The API returns {"error": {"code", "message"}} with a Hebrew message: show it as is. */
const handleErrors = (response, z) => {
  if (response.status === 401) throw new z.errors.RefreshAuthError('מפתח ה-API לא תקין או בוטל. צריך לחבר מחדש את החשבון.');
  if (response.status >= 400 && !response.skipThrowForStatus) {
    let message = `שגיאה ${response.status}`;
    let code = 'error';
    try {
      const body = JSON.parse(response.content);
      if (body.error) {
        message = body.error.message || message;
        code = body.error.code || code;
      }
    } catch (e) {}
    if (response.status === 429) throw new z.errors.ThrottledError(message, 60);
    throw new z.errors.Error(message, code, response.status);
  }
  return response;
};

/** REST hooks: Zapier registers a webhook when a Zap is turned on and removes it when turned off */
const subscribe = (events) => async (z, bundle) => {
  const res = await z.request({ method: 'POST', url: `${BASE_URL}/v1/webhooks`, body: { url: bundle.targetUrl, events } });
  return res.data;
};
const unsubscribe = async (z, bundle) => {
  const res = await z.request({ method: 'DELETE', url: `${BASE_URL}/v1/webhooks/${bundle.subscribeData.id}` });
  return res.data;
};

module.exports = { addAuth, handleErrors, subscribe, unsubscribe };
