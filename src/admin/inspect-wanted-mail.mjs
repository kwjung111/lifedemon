import { createGmailClient, gmailConfig, messageHeaders } from "../integrations/gmail.mjs";

const config = gmailConfig();
const client = createGmailClient({ config });
const result = await client.listMessages({ query: process.argv.slice(2).join(" ") || config.query, maxResults: 20 });
const rows = [];
for (const message of result.messages || []) {
  const full = await client.getMessage(message.id, "metadata");
  rows.push({ id: message.id, ...messageHeaders(full) });
}
console.log(JSON.stringify({ count: rows.length, messages: rows }, null, 2));
