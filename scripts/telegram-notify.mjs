const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const text = process.argv.slice(2).join(" ").trim();

if (!token) {
  console.error("TELEGRAM_BOT_TOKEN is not configured.");
  process.exit(1);
}

if (!chatId) {
  console.error("TELEGRAM_CHAT_ID is not configured.");
  process.exit(1);
}

if (!text) {
  console.error('Usage: npm run notify -- "message"');
  process.exit(1);
}

const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  }),
});

const result = await response.json().catch(() => null);

if (!response.ok || !result?.ok) {
  const description = result?.description ?? `HTTP ${response.status}`;
  throw new Error(`Telegram sendMessage failed: ${description}`);
}

console.log("Telegram notification sent.");
