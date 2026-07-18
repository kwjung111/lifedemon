export async function runReminderWorkerPass(state, {
  calendarConfig,
  syncCalendar,
  deliverDueReminders,
  nowMs = () => Date.now(),
  log = console.log,
  logError = console.error,
}) {
  await deliverDueReminders();

  let calendarSync = null;
  if (calendarConfig.configured && nowMs() >= state.nextCalendarSyncAt && !state.calendarSyncPromise) {
    state.nextCalendarSyncAt = nowMs() + calendarConfig.syncIntervalMs;
    calendarSync = Promise.resolve()
      .then(syncCalendar)
      .then((result) => {
        if (result.imported || result.cancelled || result.created || result.updated || result.deleted || result.errors?.length) {
          log("Google Calendar sync", result);
        }
      })
      .catch((error) => logError(new Date().toISOString(), error.message))
      .finally(() => {
        state.calendarSyncPromise = null;
      });
    state.calendarSyncPromise = calendarSync;
  }
  return { calendarSync };
}
