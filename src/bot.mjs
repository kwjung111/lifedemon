import { createBotRuntime } from "./core/bot-runtime.mjs";
import {
  beginTelegramUpdate,
  completeTelegramUpdate,
  failTelegramUpdate,
  getPlatformSetting,
  setPlatformSetting,
} from "./core/state.mjs";
import { botModules, syncTelegramMenu } from "./modules.mjs";
import { chatId, sendMessage, telegram } from "./telegram.mjs";

await syncTelegramMenu(telegram, chatId);

const bot = createBotRuntime({
  telegram,
  sendMessage,
  allowedChatId: chatId,
  allowedUserId: process.env.TELEGRAM_USER_ID || chatId,
  modules: botModules,
  loadOffset: () => getPlatformSetting("telegram_offset", "0"),
  saveOffset: (offset) => setPlatformSetting("telegram_offset", offset),
  beginUpdate: beginTelegramUpdate,
  completeUpdate: completeTelegramUpdate,
  failUpdate: failTelegramUpdate,
});

await bot.run();
