import { dueReminders, markReminderFired } from "./core/state.mjs";
import { formatReminderTime } from "./apps/reminders/service.mjs";
import { sendMessage } from "./telegram.mjs";
import { resolveReminder } from "./reminder-resolvers.mjs";

console.log("Reminder worker started");
while (true) {
  try {
    for (const reminder of dueReminders()) {
      const resolved = await resolveReminder(reminder);
      await sendMessage(
        `⏰ 알림\n\n${reminder.title}\n시각: ${formatReminderTime(reminder.due_at)}${
          resolved.note ? `\n${resolved.note}` : ""
        }${resolved.url ? `\n\n확인: ${resolved.url}` : ""}`,
      );
      markReminderFired(reminder.id);
    }
  } catch (error) {
    console.error(new Date().toISOString(), error.message);
  }
  await new Promise((resolve) => setTimeout(resolve, 30_000));
}
