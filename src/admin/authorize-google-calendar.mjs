import { createHash, randomBytes } from "node:crypto";
import { chmod, readFile, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { googleCalendarValues, mergeGoogleCalendarEnv } from "./google-calendar-env.mjs";

const clientId = String(process.env.GOOGLE_OAUTH_CLIENT_ID || "").trim();
const clientSecret = String(process.env.GOOGLE_OAUTH_CLIENT_SECRET || "").trim();
const outputPath = process.argv[2];

if (!clientId || !clientSecret) {
  throw new Error("GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET are required");
}
if (!outputPath) throw new Error("usage: node authorize-google-calendar.mjs OUTPUT_ENV_FILE");

const state = randomBytes(24).toString("base64url");
const verifier = randomBytes(48).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");

const server = createServer();
server.listen(0, "127.0.0.1");
await new Promise((resolve, reject) => {
  server.once("listening", resolve);
  server.once("error", reject);
});

const { port } = server.address();
const redirectUri = `http://127.0.0.1:${port}/oauth/callback`;
const authorizeUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authorizeUrl.search = new URLSearchParams({
  client_id: clientId,
  redirect_uri: redirectUri,
  response_type: "code",
  scope: "https://www.googleapis.com/auth/calendar.app.created",
  access_type: "offline",
  prompt: "consent",
  state,
  code_challenge: challenge,
  code_challenge_method: "S256",
}).toString();

await writeFile(`${outputPath}.auth-url`, String(authorizeUrl), { mode: 0o600 });
await chmod(`${outputPath}.auth-url`, 0o600);
console.log(`AUTH_URL_FILE=${outputPath}.auth-url`);

const callback = new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("OAuth authorization timed out")), 5 * 60_000);
  server.once("request", async (request, response) => {
    try {
      const url = new URL(request.url, redirectUri);
      if (url.pathname !== "/oauth/callback") throw new Error("unexpected callback path");
      if (url.searchParams.get("state") !== state) throw new Error("OAuth state mismatch");
      const code = url.searchParams.get("code");
      if (!code) throw new Error(url.searchParams.get("error") || "authorization code missing");

      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end("Life Daemon Google Calendar authorization completed. You may close this tab.");
      clearTimeout(timeout);
      resolve(code);
    } catch (error) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("Google Calendar authorization failed.");
      clearTimeout(timeout);
      reject(error);
    }
  });
});

try {
  const code = await callback;
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const token = await tokenResponse.json().catch(() => null);
  if (!tokenResponse.ok || !token?.refresh_token || !token?.access_token) {
    throw new Error(`Google OAuth token exchange failed (${tokenResponse.status})`);
  }

  const existingEnv = await readFile(outputPath, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const existingCalendarId = googleCalendarValues(existingEnv).GOOGLE_CALENDAR_ID;
  let calendar = null;
  if (existingCalendarId) {
    const response = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(existingCalendarId)}`,
      {
        headers: { authorization: `Bearer ${token.access_token}` },
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (response.ok) calendar = await response.json();
    else if (response.status !== 404) throw new Error(`Google Calendar lookup failed (${response.status})`);
  }
  if (!calendar) {
    const calendarResponse = await fetch("https://www.googleapis.com/calendar/v3/calendars", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token.access_token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ summary: "Life Daemon", timeZone: "Asia/Seoul" }),
      signal: AbortSignal.timeout(30_000),
    });
    calendar = await calendarResponse.json().catch(() => null);
    if (!calendarResponse.ok || !calendar?.id) {
      throw new Error(`Google Calendar creation failed (${calendarResponse.status})`);
    }
  }

  const googleLines = [
    "GOOGLE_CALENDAR_ENABLED=true",
    `GOOGLE_CALENDAR_ID=${calendar.id}`,
    `GOOGLE_OAUTH_CLIENT_ID=${clientId}`,
    `GOOGLE_OAUTH_CLIENT_SECRET=${clientSecret}`,
    `GOOGLE_OAUTH_REFRESH_TOKEN=${token.refresh_token}`,
    "GOOGLE_CALENDAR_SYNC_INTERVAL_MS=60000",
  ];
  const env = mergeGoogleCalendarEnv(existingEnv, googleLines);
  await writeFile(outputPath, env, { mode: 0o600 });
  await chmod(outputPath, 0o600);
  console.log(`AUTHORIZED_ENV=${outputPath}`);
} finally {
  server.close();
  await unlink(`${outputPath}.auth-url`).catch(() => {});
}
