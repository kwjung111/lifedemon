import assert from "node:assert/strict";
import test from "node:test";
import { runReminderWorkerPass } from "../src/apps/reminders/worker-pass.mjs";

test("delivers due reminders even when Calendar synchronization fails", async () => {
  const state = { nextCalendarSyncAt: 0 };
  let delivered = 0;
  const errors = [];

  const { calendarSync } = await runReminderWorkerPass(state, {
    calendarConfig: { configured: true, syncIntervalMs: 60_000 },
    syncCalendar: async () => { throw new Error("calendar unavailable"); },
    deliverDueReminders: async () => { delivered += 1; },
    nowMs: () => 1_000,
    logError: (...args) => errors.push(args),
  });
  await calendarSync;

  assert.equal(delivered, 1);
  assert.equal(state.nextCalendarSyncAt, 61_000);
  assert.match(errors[0][1], /calendar unavailable/);
});
