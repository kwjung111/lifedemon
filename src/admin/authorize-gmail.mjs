import { createHash, randomBytes } from "node:crypto";
import { chmod, writeFile } from "node:fs/promises";
import { createServer } from "node:http";

const clientId = String(process.env.GOOGLE_OAUTH_CLIENT_ID || "").trim();
const clientSecret = String(process.env.GOOGLE_OAUTH_CLIENT_SECRET || "").trim();
const outputPath = process.argv[2];
const port = Number(process.env.GMAIL_OAUTH_CALLBACK_PORT) || 42817;
if (!clientId || !clientSecret) throw new Error("GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET are required");
if (!outputPath) throw new Error("usage: node authorize-gmail.mjs OUTPUT_ENV_FILE");

const state = randomBytes(24).toString("base64url");
const verifier = randomBytes(48).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const redirectUri = `http://127.0.0.1:${port}/oauth/callback`;
const authorizeUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authorizeUrl.search = new URLSearchParams({
  client_id: clientId,
  redirect_uri: redirectUri,
  response_type: "code",
  scope: "https://www.googleapis.com/auth/gmail.readonly",
  access_type: "offline",
  prompt: "consent",
  state,
  code_challenge: challenge,
  code_challenge_method: "S256",
}).toString();

const server = createServer();
server.listen(port, "127.0.0.1");
await new Promise((resolve, reject) => {
  server.once("listening", resolve);
  server.once("error", reject);
});

console.log(`AUTH_URL=${authorizeUrl}`);
const callback = new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("Gmail OAuth authorization timed out")), 10 * 60_000);
  server.once("request", (request, response) => {
    try {
      const url = new URL(request.url, redirectUri);
      if (url.pathname !== "/oauth/callback") throw new Error("unexpected callback path");
      if (url.searchParams.get("state") !== state) throw new Error("OAuth state mismatch");
      const code = url.searchParams.get("code");
      if (!code) throw new Error(url.searchParams.get("error") || "authorization code missing");
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end("Life Daemon Gmail read-only authorization completed. You may close this tab.");
      clearTimeout(timeout);
      resolve(code);
    } catch (error) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("Gmail authorization failed.");
      clearTimeout(timeout);
      reject(error);
    }
  });
});

try {
  const code = await callback;
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, code_verifier: verifier, grant_type: "authorization_code", redirect_uri: redirectUri }),
    signal: AbortSignal.timeout(30_000),
  });
  const token = await response.json().catch(() => null);
  if (!response.ok || !token?.refresh_token) throw new Error(`Google OAuth token exchange failed (${response.status})`);
  const lines = [
    "GMAIL_WANTED_ENABLED=true",
    'GMAIL_WANTED_QUERY=label:"BOT/Wanted" newer_than:30d',
    `GMAIL_OAUTH_REFRESH_TOKEN=${token.refresh_token}`,
    "",
  ];
  await writeFile(outputPath, lines.join("\n"), { mode: 0o600 });
  await chmod(outputPath, 0o600);
  console.log(`AUTHORIZED_ENV=${outputPath}`);
} finally {
  server.close();
}
