import { createReminder } from "../../core/state.mjs";
import { sendMessage } from "../../telegram.mjs";

export function kstDateTimeToIso(date, time) {
  const timeMatch = String(time).match(/^(\d{1,2}):([0-5]\d)$/);
  const hour = Number(timeMatch?.[1]);
  if (!isValidCalendarDate(date) || !timeMatch || hour > 23) {
    throw new Error("올바르지 않은 알림 시각입니다.");
  }
  const normalizedTime = `${String(hour).padStart(2, "0")}:${timeMatch[2]}`;
  const parsed = new Date(`${date}T${normalizedTime}:00+09:00`);
  if (Number.isNaN(parsed.getTime())) throw new Error("올바르지 않은 알림 시각입니다.");
  return parsed.toISOString();
}

export function isValidCalendarDate(date) {
  const match = String(date || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function formatReminderTime(dueAt) {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(dueAt));
}

export async function proposeReminder(input, { intro = null } = {}) {
  const reminder = createReminder(input);
  if (reminder.status === "approved" || reminder.status === "fired") return reminder;
  await sendMessage(
    `${intro ? `${intro}\n\n` : ""}🔔 이 알림을 등록할까요?\n\n[일시] ${formatReminderTime(reminder.due_at)}\n[내용] ${reminder.title}${
      input.metadata?.assumedTime ? "\n※ 공식 발표 시각이 없어 오전 9시 기준으로 제안합니다." : ""
    }${
      reminder.resolver ? "\n링크: 알림 시점에 공식 사이트에서 자동 탐색"
        : reminder.url ? `\n링크: ${reminder.url}` : ""
    }`,
    {
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ 등록", callback_data: `r:ok:${reminder.id}` },
          { text: "취소", callback_data: `r:no:${reminder.id}` },
        ]],
      },
    },
    {
      context: input.metadata?.noticeId || input.metadata?.entityId
        ? {
          domain: input.metadata.domain || (input.metadata.noticeId ? "housing" : input.module),
          kind: "item",
          entityId: input.metadata.noticeId || input.metadata.entityId,
        }
        : null,
    },
  );
  return reminder;
}
