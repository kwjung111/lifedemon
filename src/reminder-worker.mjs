import { dueReminders, markReminderFired } from "./core/state.mjs";
import { formatReminderTime } from "./apps/reminders/service.mjs";
import { sendMessage } from "./telegram.mjs";
import { resolveReminder } from "./reminder-resolvers.mjs";
import { googleCalendarConfig, syncGoogleCalendar } from "./integrations/google-calendar.mjs";

console.log("Reminder worker started");
const calendarConfig = googleCalendarConfig();
let nextCalendarSyncAt = 0;
while (true) {
  try {
    if (calendarConfig.configured && Date.now() >= nextCalendarSyncAt) {
      nextCalendarSyncAt = Date.now() + calendarConfig.syncIntervalMs;
      const result = await syncGoogleCalendar();
      if (result.imported || result.cancelled || result.created || result.updated || result.deleted || result.errors?.length) {
        console.log("Google Calendar sync", result);
      }
    }
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
    nextCalendarSyncAt = Date.now() + calendarConfig.syncIntervalMs;
  }
  await new Promise((resolve) => setTimeout(resolve, 30_000));
}
