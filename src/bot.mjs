import { housingBotModule } from "./apps/housing/bot-module.mjs";
import { reminderBotModule } from "./apps/reminders/bot-module.mjs";
import { createBotRuntime } from "./core/bot-runtime.mjs";
import { getPlatformSetting, setPlatformSetting } from "./core/state.mjs";
import { chatId, sendMessage, telegram } from "./telegram.mjs";

const bot = createBotRuntime({
  telegram,
  sendMessage,
  allowedChatId: chatId,
  modules: [reminderBotModule, housingBotModule],
  loadOffset: () => getPlatformSetting("telegram_offset", "0"),
  saveOffset: (offset) => setPlatformSetting("telegram_offset", offset),
});

await bot.run();
