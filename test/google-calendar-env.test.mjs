import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCompatibleCalendarId, googleCalendarLinesFromEnv, googleCalendarValues,
  mergeGoogleCalendarEnv,
} from "../src/admin/google-calendar-env.mjs";

test("replaces Google settings while preserving the service environment", () => {
  const existing = [
    "TELEGRAM_BOT_TOKEN=telegram-secret",
    "GOOGLE_CALENDAR_ENABLED=false",
    "GOOGLE_OAUTH_REFRESH_TOKEN=old-token",
    "MYHOME_API_SERVICE_KEY=myhome-secret",
    "",
  ].join("\n");

  const merged = mergeGoogleCalendarEnv(existing, [
    "GOOGLE_CALENDAR_ENABLED=true",
    "GOOGLE_OAUTH_REFRESH_TOKEN=new-token",
  ]);

  assert.equal(merged, [
    "TELEGRAM_BOT_TOKEN=telegram-secret",
    "MYHOME_API_SERVICE_KEY=myhome-secret",
    "",
    "GOOGLE_CALENDAR_ENABLED=true",
    "GOOGLE_OAUTH_REFRESH_TOKEN=new-token",
    "",
  ].join("\n"));
});

test("fails closed when installing credentials for a different calendar", () => {
  assert.doesNotThrow(() => assertCompatibleCalendarId(
    { GOOGLE_CALENDAR_ID: "same-calendar" },
    "GOOGLE_CALENDAR_ID=same-calendar\n",
  ));
  assert.throws(
    () => assertCompatibleCalendarId(
      { GOOGLE_CALENDAR_ID: "new-calendar" },
      "TELEGRAM_BOT_TOKEN=secret\nGOOGLE_CALENDAR_ID=old-calendar\n",
    ),
    /migrate or clear existing reminder mappings/,
  );
});

test("creates a Google-only environment when the target does not exist", () => {
  assert.equal(
    mergeGoogleCalendarEnv("", ["GOOGLE_CALENDAR_ENABLED=true"]),
    "GOOGLE_CALENDAR_ENABLED=true\n",
  );
});

test("extracts only Google Calendar settings from an uploaded environment", () => {
  const source = [
    "TELEGRAM_BOT_TOKEN=do-not-copy",
    "GOOGLE_CALENDAR_ID=calendar-id",
    "GOOGLE_OAUTH_REFRESH_TOKEN=refresh-token",
  ].join("\n");
  assert.deepEqual(googleCalendarLinesFromEnv(source), [
    "GOOGLE_CALENDAR_ID=calendar-id",
    "GOOGLE_OAUTH_REFRESH_TOKEN=refresh-token",
  ]);
  assert.deepEqual(googleCalendarValues(source), {
    GOOGLE_CALENDAR_ID: "calendar-id",
    GOOGLE_OAUTH_REFRESH_TOKEN: "refresh-token",
  });
});
