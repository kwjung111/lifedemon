import { housingBotModule } from "./apps/housing/bot-module.mjs";
import { jobsBotModule } from "./apps/jobs/bot-module.mjs";
import { feedbackBotModule } from "./apps/feedback/bot-module.mjs";
import { managerBotModule } from "./apps/manager/bot-module.mjs";
import { reminderBotModule } from "./apps/reminders/bot-module.mjs";
import { briefingBotModule } from "./apps/briefing/bot-module.mjs";
import { inboxBotModule } from "./apps/inbox/bot-module.mjs";
import { manualBotModule } from "./apps/manual/bot-module.mjs";
import { navigationBotModule } from "./apps/navigation/bot-module.mjs";

export const botModules = [
  manualBotModule,
  reminderBotModule,
  briefingBotModule,
  housingBotModule,
  jobsBotModule,
  feedbackBotModule,
  managerBotModule,
  navigationBotModule,
  inboxBotModule,
];

export function telegramMenuCommands() {
  return [
    { command: "help", description: "📖 처음이라면 여기" },
    { command: "briefing", description: "☀️ 오늘 핵심 브리핑" },
    { command: "inbox", description: "📥 저장한 일정·할 일" },
    { command: "reminders", description: "🔔 예정 알림 확인·취소" },
    { command: "housing_status", description: "🏠 주택 지원 진행" },
    { command: "job_status", description: "💼 채용 지원 진행" },
    { command: "ask", description: "🧭 서버 상태·사용량 질문" },
  ];
}

export async function syncTelegramMenu(telegram, chatId) {
  const commands = telegramMenuCommands();
  await telegram("setMyCommands", {
    scope: { type: "chat", chat_id: chatId },
    commands,
  });
  return commands;
}
