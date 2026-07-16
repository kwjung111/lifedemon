const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
  console.error("TELEGRAM_BOT_TOKEN is not configured.");
  process.exit(1);
}

const response = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, {
  headers: { accept: "application/json" },
});
const result = await response.json().catch(() => null);

if (!response.ok || !result?.ok) {
  const description = result?.description ?? `HTTP ${response.status}`;
  throw new Error(`Telegram getUpdates failed: ${description}`);
}

const chats = new Map();
for (const update of result.result) {
  const chat = update.message?.chat ?? update.edited_message?.chat;
  if (chat) chats.set(String(chat.id), chat);
}

if (chats.size === 0) {
  console.log("No chats found. Send /start to the bot, then run this command again.");
  process.exit(2);
}

for (const [id, chat] of chats) {
  const label =
    [chat.first_name, chat.last_name].filter(Boolean).join(" ") ||
    chat.username ||
    chat.title ||
    "unknown";
  console.log(`TELEGRAM_CHAT_ID=${id} (${label}, ${chat.type})`);
}
