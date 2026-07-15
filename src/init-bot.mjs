import { telegramMenuCommands } from "./modules.mjs";
import { chatId, telegram } from "./telegram.mjs";

const commands = telegramMenuCommands();
await telegram("setMyCommands", {
  scope: { type: "chat", chat_id: chatId },
  commands,
});

const registered = await telegram("getMyCommands", {
  scope: { type: "chat", chat_id: chatId },
});
console.log(`registered ${registered.length} Telegram menu commands`);
for (const item of registered) console.log(`/${item.command} - ${item.description}`);
