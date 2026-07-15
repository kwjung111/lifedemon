import { createReminder } from "../../core/state.mjs";
import { sendMessage } from "../../telegram.mjs";

export function kstDateTimeToIso(date, time) {
  const parsed = new Date(`${date}T${time}:00+09:00`);
  if (Number.isNaN(parsed.getTime())) throw new Error("올바르지 않은 알림 시각입니다.");
  return parsed.toISOString();
}

export function formatReminderTime(dueAt) {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(dueAt));
}

export async function proposeReminder(input) {
  const reminder = createReminder(input);
  if (reminder.status === "approved" || reminder.status === "fired") return reminder;
  await sendMessage(
    `🔔 알림을 등록할까요?\n\n${reminder.title}\n시각: ${formatReminderTime(reminder.due_at)}${
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
  );
  return reminder;
}
