import { createBotRuntime } from "./core/bot-runtime.mjs";
import {
  beginTelegramUpdate,
  completeTelegramUpdate,
  failTelegramUpdate,
  getPlatformSetting,
  setPlatformSetting,
  telegramMessageContext,
} from "./core/state.mjs";
import { botModules, syncTelegramMenu } from "./modules.mjs";
import { chatId, sendMessage, telegram } from "./telegram.mjs";
import { interpretMessage as interpretTelegramMessage } from "./core/message-interpreter.mjs";
import { getNotice } from "./db.mjs";
import { getJobPosting } from "./apps/jobs/db.mjs";

function pendingReminderText() {
  try {
    const pending = JSON.parse(getPlatformSetting("reminder_ai_clarification", "null"));
    if (!pending?.text || Date.now() - Date.parse(pending.createdAt) > 10 * 60_000) return null;
    return pending.text;
  } catch { return null; }
}

function recommendationSummary(row) {
  try { return JSON.parse(row?.ai_result_json || row?.result_json || "null")?.summary || null; }
  catch { return null; }
}

function hydratedMessageContext(messageId) {
  const context = telegramMessageContext(messageId);
  if (!context?.items?.length) return context;
  return {
    ...context,
    items: context.items.map((item) => {
      const domain = item.domain || context.domain;
      const entity = domain === "jobs" ? getJobPosting(item.id)
        : domain === "housing" ? getNotice(item.id) : null;
      if (!entity) return item;
      return {
        ...item, domain,
        title: item.title || entity.title || null,
        company: item.company || entity.company || null,
        source: item.source || entity.source || null,
        summary: item.summary || recommendationSummary(entity),
      };
    }),
  };
}

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
  messageContext: hydratedMessageContext,
  interpretMessage: (message, context) => interpretTelegramMessage(message, context, {
    pendingReminder: pendingReminderText(),
  }),
});

await bot.run();
