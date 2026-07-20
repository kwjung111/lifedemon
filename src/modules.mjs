import { housingBotModule } from "./apps/housing/bot-module.mjs";
import { jobsBotModule } from "./apps/jobs/bot-module.mjs";
import { feedbackBotModule } from "./apps/feedback/bot-module.mjs";
import { managerBotModule } from "./apps/manager/bot-module.mjs";
import { reminderBotModule } from "./apps/reminders/bot-module.mjs";
import { briefingBotModule } from "./apps/briefing/bot-module.mjs";

export const botModules = [reminderBotModule, briefingBotModule, housingBotModule, jobsBotModule, feedbackBotModule, managerBotModule];

export function telegramMenuCommands() {
  const commands = [
    { command: "help", description: "📖 전체 기능과 사용법" },
    ...botModules.flatMap((module) => module.commands || []),
  ];
  const seen = new Set();
  return commands.filter(({ command }) => {
    if (seen.has(command)) return false;
    seen.add(command);
    return true;
  });
}

export async function syncTelegramMenu(telegram, chatId) {
  const commands = telegramMenuCommands();
  await telegram("setMyCommands", {
    scope: { type: "chat", chat_id: chatId },
    commands,
  });
  return commands;
}
