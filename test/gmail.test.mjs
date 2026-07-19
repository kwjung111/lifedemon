import assert from "node:assert/strict";
import test from "node:test";
import { gmailConfig, messageHeaders } from "../src/integrations/gmail.mjs";
import { gmailLinesFromEnv, mergeGmailEnv } from "../src/admin/gmail-env.mjs";

test("keeps Gmail credentials separate and reads only configured Wanted mail", () => {
  const config = gmailConfig({ GMAIL_WANTED_ENABLED: "true", GOOGLE_OAUTH_CLIENT_ID: "id", GOOGLE_OAUTH_CLIENT_SECRET: "secret", GMAIL_OAUTH_REFRESH_TOKEN: "refresh", GMAIL_WANTED_QUERY: 'label:"BOT/Wanted" newer_than:30d' });
  assert.equal(config.configured, true);
  assert.equal(config.query, 'label:"BOT/Wanted" newer_than:30d');
  assert.deepEqual(messageHeaders({ payload: { headers: [{ name: "From", value: "Wanted" }, { name: "Subject", value: "Jobs" }] } }), { from: "Wanted", subject: "Jobs", date: "" });
});

test("merges only Gmail settings into the service environment", () => {
  const merged = mergeGmailEnv("TELEGRAM=x\nGMAIL_OLD=y\n", ["GMAIL_WANTED_ENABLED=true", "GMAIL_OAUTH_REFRESH_TOKEN=z"]);
  assert.equal(merged, "TELEGRAM=x\n\nGMAIL_WANTED_ENABLED=true\nGMAIL_OAUTH_REFRESH_TOKEN=z\n");
  assert.deepEqual(gmailLinesFromEnv(merged), ["GMAIL_WANTED_ENABLED=true", "GMAIL_OAUTH_REFRESH_TOKEN=z"]);
});
