import { createBotRuntime } from "./core/bot-runtime.mjs";
import { getPlatformSetting, setPlatformSetting } from "./core/state.mjs";
import { botModules } from "./modules.mjs";
import { chatId, sendMessage, telegram } from "./telegram.mjs";

const bot = createBotRuntime({
  telegram,
  sendMessage,
  allowedChatId: chatId,
  modules: botModules,
  loadOffset: () => getPlatformSetting("telegram_offset", "0"),
  saveOffset: (offset) => setPlatformSetting("telegram_offset", offset),
});

await bot.run();
