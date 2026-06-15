const https = require('https');
const { decryptToken } = require('./crypto');

function getGraphVersion() {
  return process.env.META_GRAPH_VERSION || 'v19.0';
}

function getFacebookDialogHost() {
  return 'https://www.facebook.com';
}

function graphRequest(method, path, token, payload) {
  const body = payload ? JSON.stringify(payload) : null;
  const options = {
    hostname: 'graph.facebook.com',
    path: `/${getGraphVersion()}${path}`,
    method,
    headers: {}
  };
  if (token) options.headers.Authorization = `Bearer ${token}`;
  if (body) {
    options.headers['Content-Type'] = 'application/json';
    options.headers['Content-Length'] = Buffer.byteLength(body);
  }
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = {};
        try {
          parsed = raw ? JSON.parse(raw) : {};
        } catch (error) {
          parsed = { raw };
        }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(parsed);
        const message = scrubToken(`meta_graph_${res.statusCode}: ${raw.slice(0, 600)}`);
        return reject(new Error(message));
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function buildFacebookOAuthUrl({ appId, redirectUri, state, scopes }) {
  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    state,
    response_type: 'code',
    scope: scopes.join(',')
  });
  return `${getFacebookDialogHost()}/${getGraphVersion()}/dialog/oauth?${params.toString()}`;
}

function exchangeOAuthCode({ appId, appSecret, redirectUri, code }) {
  const params = new URLSearchParams({
    client_id: appId,
    client_secret: appSecret,
    redirect_uri: redirectUri,
    code
  });
  return graphRequest('GET', `/oauth/access_token?${params.toString()}`, '');
}

function exchangeLongLivedUserToken({ appId, appSecret, accessToken }) {
  const params = new URLSearchParams({
    grant_type: 'fb_exchange_token',
    client_id: appId,
    client_secret: appSecret,
    fb_exchange_token: accessToken
  });
  return graphRequest('GET', `/oauth/access_token?${params.toString()}`, '');
}

function getUserPages(userToken) {
  return graphRequest('GET', '/me/accounts?fields=id,name,access_token,perms,tasks', userToken);
}

function getPageInfo(pageToken, pageId) {
  const fields = encodeURIComponent('id,name,access_token,tasks,perms');
  return graphRequest('GET', `/${encodeURIComponent(pageId)}?fields=${fields}`, pageToken);
}

function subscribePageToApp(pageToken, pageId, fields) {
  if (!pageToken || !pageId) throw new Error('meta_page_subscription_not_configured');
  const subscribedFields = encodeURIComponent((fields || getDefaultSubscribedFields()).join(','));
  return graphRequest('POST', `/${encodeURIComponent(pageId)}/subscribed_apps?subscribed_fields=${subscribedFields}`, pageToken);
}

function getDefaultSubscribedFields() {
  const custom = String(process.env.META_SUBSCRIBED_FIELDS || '').trim();
  if (custom) return custom.split(',').map((field) => field.trim()).filter(Boolean);
  return ['messages', 'messaging_postbacks', 'feed', 'leadgen'];
}

function sendMessengerText(page, recipientId, text) {
  const token = decryptToken(page.page_access_token_encrypted);
  if (!token || !page.page_id) throw new Error('meta_page_not_configured');
  return graphRequest('POST', `/${encodeURIComponent(page.page_id)}/messages`, token, {
    recipient: { id: recipientId },
    messaging_type: 'RESPONSE',
    message: { text }
  });
}

function replyToComment(page, commentId, text) {
  const token = decryptToken(page.page_access_token_encrypted);
  if (!token || !commentId) throw new Error('meta_comment_not_configured');
  return graphRequest('POST', `/${encodeURIComponent(commentId)}/comments`, token, { message: text });
}

function getLeadDetails(page, leadgenId) {
  const token = decryptToken(page.page_access_token_encrypted);
  if (!token || !leadgenId) throw new Error('meta_lead_not_configured');
  const fields = encodeURIComponent('id,created_time,field_data,ad_id,ad_name,form_id,platform');
  return graphRequest('GET', `/${encodeURIComponent(leadgenId)}?fields=${fields}`, token);
}

function scrubToken(message) {
  return String(message || '').replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]');
}

module.exports = {
  getGraphVersion,
  graphRequest,
  buildFacebookOAuthUrl,
  exchangeOAuthCode,
  exchangeLongLivedUserToken,
  getUserPages,
  getPageInfo,
  subscribePageToApp,
  getDefaultSubscribedFields,
  sendMessengerText,
  replyToComment,
  getLeadDetails,
  scrubToken
};
