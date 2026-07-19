const apiRoot = "https://gmail.googleapis.com/gmail/v1/users/me";
const tokenUrl = "https://oauth2.googleapis.com/token";
const clean = (value) => String(value || "").trim();

export function gmailConfig(env = process.env) {
  const enabled = /^(1|true|yes)$/i.test(clean(env.GMAIL_WANTED_ENABLED));
  const config = {
    enabled,
    clientId: clean(env.GOOGLE_OAUTH_CLIENT_ID),
    clientSecret: clean(env.GOOGLE_OAUTH_CLIENT_SECRET),
    refreshToken: clean(env.GMAIL_OAUTH_REFRESH_TOKEN),
    query: clean(env.GMAIL_WANTED_QUERY) || 'label:"BOT/Wanted" newer_than:30d',
  };
  config.configured = Boolean(enabled && config.clientId && config.clientSecret && config.refreshToken);
  return config;
}

export function createGmailClient({ config = gmailConfig(), fetchImpl = globalThis.fetch } = {}) {
  if (!config.configured) throw new Error("Gmail Wanted reader is not configured");
  let token = null;
  let expiresAt = 0;

  async function accessToken() {
    if (token && Date.now() < expiresAt - 60_000) return token;
    const response = await fetchImpl(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: config.refreshToken,
        grant_type: "refresh_token",
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.access_token) throw new Error(`Gmail OAuth HTTP ${response.status}`);
    token = payload.access_token;
    expiresAt = Date.now() + (Number(payload.expires_in) || 3600) * 1000;
    return token;
  }

  async function request(path) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetchImpl(`${apiRoot}${path}`, {
        headers: { authorization: `Bearer ${await accessToken()}` },
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 401 && attempt === 0) {
        await response.arrayBuffer().catch(() => null);
        token = null;
        expiresAt = 0;
        continue;
      }
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(`Gmail API HTTP ${response.status}`);
      return payload;
    }
    throw new Error("Gmail authentication retry failed");
  }

  return {
    async listMessages({ query = config.query, maxResults = 50 } = {}) {
      const params = new URLSearchParams({ q: query, maxResults: String(maxResults) });
      return request(`/messages?${params}`);
    },
    getMessage(id, format = "full") {
      return request(`/messages/${encodeURIComponent(id)}?format=${encodeURIComponent(format)}`);
    },
  };
}

export function messageHeaders(message) {
  const rows = message?.payload?.headers || [];
  const headers = Object.fromEntries(rows.map((row) => [String(row.name || "").toLowerCase(), String(row.value || "")]));
  return { from: headers.from || "", subject: headers.subject || "", date: headers.date || "" };
}
