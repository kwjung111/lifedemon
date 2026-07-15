import { getReminder, listReminders, setReminderStatus } from "../../core/state.mjs";
import { sendMessage, telegram } from "../../telegram.mjs";
import { formatReminderTime, kstDateTimeToIso, proposeReminder } from "./service.mjs";

function parseCreate(text) {
  const match = text.match(/^(?:\/remind(?:@\w+)?|알림\s*등록)\s+(20\d{2}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})\s+(.+)$/i);
  if (!match) return null;
  const [title, url] = match[3].split(/\s*\|\s*(?=https?:\/\/)/, 2);
  return { date: match[1], time: match[2], title: title.trim(), url: url?.trim() || null };
}

export const reminderBotModule = {
  id: "reminders",
  help: "🔔 전역 알림\n/reminders : 예정 알림 목록\n/remind 2026-07-20 16:00 서류 발표 [| 선택 링크]",

  canHandleCallback(query) {
    return String(query.data || "").startsWith("r:");
  },

  async handleCallback(query) {
    const [, action, idText] = String(query.data || "").split(":");
    const reminder = getReminder(Number(idText));
    if (!reminder) {
      await telegram("answerCallbackQuery", { callback_query_id: query.id, text: "알림을 찾지 못했습니다." });
      return;
    }
    const approved = action === "ok";
    setReminderStatus(reminder.id, approved ? "approved" : "cancelled");
    await telegram("answerCallbackQuery", {
      callback_query_id: query.id,
      text: approved ? "알림을 등록했습니다." : "알림을 취소했습니다.",
    });
    await telegram("editMessageText", {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
      text: `${approved ? "✅ 등록된 알림" : "❌ 취소된 알림"}\n\n${reminder.title}\n시각: ${formatReminderTime(reminder.due_at)}${
        reminder.resolver ? "\n링크: 알림 시점에 공식 사이트에서 자동 탐색"
          : reminder.url ? `\n링크: ${reminder.url}` : ""
      }`,
      disable_web_page_preview: true,
    });
  },

  async handleMessage(message) {
    const text = String(message.text || "").trim();
    if (/^\/reminders(?:@\w+)?$/i.test(text) || /^알림\s*(?:목록|보여줘)$/i.test(text)) {
      const reminders = listReminders();
      await sendMessage(reminders.length
        ? `🔔 예정 알림\n\n${reminders.map((item) => `${item.status === "approved" ? "✅" : "⏳"} ${item.id}. ${formatReminderTime(item.due_at)}\n${item.title}`).join("\n\n")}`
        : "예정된 알림이 없습니다.");
      return true;
    }
    const request = parseCreate(text);
    if (!request) return false;
    await proposeReminder({
      title: request.title,
      dueAt: kstDateTimeToIso(request.date, request.time),
      url: request.url,
      module: "global",
      entityKey: `manual:${request.date}:${request.time}:${request.title}`,
    });
    return true;
  },
};
