import { syncTelegramMenu } from "./modules.mjs";
import { chatId, telegram } from "./telegram.mjs";

await syncTelegramMenu(telegram, chatId);

const registered = await telegram("getMyCommands", {
  scope: { type: "chat", chat_id: chatId },
});
console.log(`registered ${registered.length} Telegram menu commands`);
for (const item of registered) console.log(`/${item.command} - ${item.description}`);
