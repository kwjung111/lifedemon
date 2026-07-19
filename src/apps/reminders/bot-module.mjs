import {
  getPlatformSetting, getReminder, listReminders, setPlatformSetting, setReminderStatus,
} from "../../core/state.mjs";
import { sendMessage, telegram } from "../../telegram.mjs";
import { formatReminderTime, kstDateTimeToIso, proposeReminder } from "./service.mjs";
import { calendarSyncStatus } from "../../integrations/google-calendar.mjs";
import { looksLikeReminderRequest, parseReminderRequest } from "./ai-parser.mjs";

function parseCreate(text) {
  const match = text.match(/^(?:\/remind(?:@\w+)?|알림\s*등록)\s+(20\d{2}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})\s+(.+)$/i);
  if (!match) return null;
  const [title, url] = match[3].split(/\s*\|\s*(?=https?:\/\/)/, 2);
  return { date: match[1], time: match[2], title: title.trim(), url: url?.trim() || null };
}

const clarificationKey = "reminder_ai_clarification";

function pendingClarification() {
  try {
    const pending = JSON.parse(getPlatformSetting(clarificationKey, "null"));
    if (!pending?.text || Date.now() - Date.parse(pending.createdAt) > 10 * 60_000) {
      setPlatformSetting(clarificationKey, "");
      return null;
    }
    return pending;
  } catch {
    return null;
  }
}

function saveClarification(text) {
  setPlatformSetting(clarificationKey, JSON.stringify({ text, createdAt: new Date().toISOString() }));
}

function clearClarification() {
  setPlatformSetting(clarificationKey, "");
}

export const reminderBotModule = {
  id: "reminders",
  help: "🔔 전역 알림\n/reminders : 예정 알림 목록\n/remind 내일 오후 4시에 서류 발표 알려줘\n정확한 형식도 가능: /remind 2026-07-20 16:00 서류 발표\n/calendar : Google Calendar 연동 상태",
  commands: [
    { command: "reminders", description: "예정된 전역 알림 보기" },
    { command: "remind", description: "자연어로 새 전역 알림 등록" },
    { command: "calendar", description: "Google Calendar 연동 상태" },
  ],

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
      text: approved ? "알림이 등록되었습니다." : "알림이 취소되었습니다.",
    });
    await telegram("editMessageText", {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
      text: approved
        ? `✅ ${formatReminderTime(reminder.due_at)}에 ${reminder.title} 등록되었습니다.${reminder.url ? `\n${reminder.url}` : ""}`
        : `❌ ${formatReminderTime(reminder.due_at)}의 ${reminder.title} 알림이 취소되었습니다.`,
      disable_web_page_preview: true,
    });
  },

  async handleMessage(message) {
    const text = String(message.text || "").trim();
    if (/^\/calendar(?:@\w+)?$/i.test(text)) {
      const status = calendarSyncStatus();
      await sendMessage([
        "📅 Google Calendar 연동",
        `상태: ${status.configured ? "✅ 사용 중" : status.enabled ? "⚠️ 설정 미완료" : "⏸ 꺼짐"}`,
        status.calendarId ? `캘린더: ${status.calendarId}` : null,
        status.lastSync ? `마지막 동기화: ${formatReminderTime(status.lastSync)}` : null,
        status.lastError ? `최근 오류: ${status.lastError}` : null,
      ].filter(Boolean).join("\n"));
      return true;
    }
    if (/^\/reminders(?:@\w+)?$/i.test(text) || /^알림\s*(?:목록|보여줘)$/i.test(text)) {
      const reminders = listReminders();
      await sendMessage(
        reminders.length
          ? `🔔 예정 알림\n\n${reminders.map((item, index) => `${item.status === "approved" ? "✅" : "⏳"} ${index + 1}. ${formatReminderTime(item.due_at)}\n${item.title}`).join("\n\n")}`
          : "예정된 알림이 없습니다.",
        reminders.length ? {
          reply_markup: {
            inline_keyboard: reminders.map((item, index) => [{
              text: `${index + 1}번 취소`, callback_data: `r:cancel:${item.id}`,
            }]),
          },
        } : {},
      );
      return true;
    }
    const strictRequest = parseCreate(text);
    if (strictRequest) {
      clearClarification();
      await proposeReminder({
        title: strictRequest.title,
        dueAt: kstDateTimeToIso(strictRequest.date, strictRequest.time),
        url: strictRequest.url,
        module: "global",
        entityKey: `manual:${strictRequest.date}:${strictRequest.time}:${strictRequest.title}`,
      });
      return true;
    }
    const pending = pendingClarification();
    if (pending && /^\//.test(text)) return false;
    if (!pending && !looksLikeReminderRequest(text)) return false;
    const requestText = pending ? `${pending.text}\n추가 답변: ${text}` : text;

    try {
      const request = await parseReminderRequest(requestText);
      if (request.intent === "not_reminder") {
        clearClarification();
        return false;
      }
      if (request.intent === "needs_clarification") {
        saveClarification(requestText);
        await sendMessage(`🕐 ${request.clarification}`);
        return true;
      }
      clearClarification();
      await proposeReminder({
        title: request.title,
        dueAt: request.dueAt,
        url: request.url,
        module: "global",
        entityKey: `manual-ai:${request.dueAt}:${request.title}`,
        metadata: { source: "telegram-ai", originalText: requestText.slice(0, 1000) },
      });
      return true;
    } catch (error) {
      clearClarification();
      console.error("Reminder AI parse failed", error.message);
      await sendMessage("⚠️ 알림 요청을 해석하지 못했습니다. 날짜와 시간을 포함해 다시 말씀해 주세요.");
      return true;
    }
  },
};
