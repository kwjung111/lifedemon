import { resolveHousingReminder } from "./apps/housing/reminder-resolver.mjs";

export async function resolveReminder(reminder) {
  if (reminder.resolver === "housing-official") return resolveHousingReminder(reminder);
  return { url: reminder.url, note: null };
}
