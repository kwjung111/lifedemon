import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "lifedemon-calendar-"));
process.env.MONITOR_DATA_DIR = dataDir;

const state = await import("../src/core/state.mjs");
const {
  createGoogleCalendarClient,
  eventStartToIso,
  googleCalendarConfig,
  syncGoogleCalendar,
} = await import("../src/integrations/google-calendar.mjs");

test.after(() => {
  state.platformDb.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test("stays disabled unless the explicit flag and every OAuth value are present", () => {
  assert.equal(googleCalendarConfig({}).configured, false);
  assert.equal(googleCalendarConfig({
    GOOGLE_CALENDAR_ENABLED: "true",
    GOOGLE_CALENDAR_ID: "calendar@example.test",
    GOOGLE_OAUTH_CLIENT_ID: "client",
    GOOGLE_OAUTH_CLIENT_SECRET: "secret",
    GOOGLE_OAUTH_REFRESH_TOKEN: "refresh",
  }).configured, true);
});

test("maps timed and all-day Google events to reminder instants", () => {
  assert.equal(eventStartToIso({ dateTime: "2026-07-20T16:00:00+09:00" }), "2026-07-20T07:00:00.000Z");
  assert.equal(eventStartToIso({ date: "2026-07-20" }), "2026-07-20T00:00:00.000Z");
  assert.equal(eventStartToIso({}), null);
});

test("synchronizes local approvals and Google edits/deletes in both directions", async () => {
  const reminder = state.createReminder({
    title: "서류 발표",
    dueAt: "2026-07-20T07:00:00.000Z",
    url: "https://example.test/result",
    module: "global",
    entityKey: "manual:calendar-test",
  });
  state.setReminderStatus(reminder.id, "approved");

  const calls = { inserted: [], updated: [], deleted: [] };
  let incoming = [];
  let insertedCount = 0;
  const client = {
    calendarId: "dedicated@example.test",
    async listEvents() {
      const items = incoming;
      incoming = [];
      return { items, nextSyncToken: `token-${Date.now()}` };
    },
    async insertEvent(event) {
      calls.inserted.push(event);
      insertedCount += 1;
      return { id: `google-${insertedCount}` };
    },
    async updateEvent(eventId, event) {
      calls.updated.push({ eventId, event });
      return { id: eventId };
    },
    async deleteEvent(eventId) {
      calls.deleted.push(eventId);
    },
  };

  const first = await syncGoogleCalendar({ client });
  assert.equal(first.created, 1);
  assert.equal(calls.inserted[0].summary, "서류 발표");
  assert.equal(state.getReminder(reminder.id).google_event_id, "google-1");

  incoming = [{
    id: "google-1",
    status: "confirmed",
    summary: "발표 시각 변경",
    htmlLink: "https://calendar.google.com/event?eid=google-1",
    updated: "2026-07-16T03:00:00.000Z",
    start: { dateTime: "2026-07-20T18:30:00+09:00" },
  }];
  const second = await syncGoogleCalendar({ client });
  assert.equal(second.imported, 1);
  assert.equal(second.updated, 0, "a pulled Google edit must not be pushed back in the same pass");
  assert.equal(state.getReminder(reminder.id).title, "발표 시각 변경");
  assert.equal(state.getReminder(reminder.id).due_at, "2026-07-20T09:30:00.000Z");
  assert.equal(state.getReminder(reminder.id).url, "https://example.test/result");

  incoming = [{ id: "google-1", status: "cancelled" }];
  await syncGoogleCalendar({ client });
  assert.equal(state.getReminder(reminder.id).status, "cancelled");

  const secondReminder = state.createReminder({
    title: "면접",
    dueAt: "2026-08-01T01:00:00.000Z",
    module: "global",
    entityKey: "manual:calendar-delete-test",
  });
  state.setReminderStatus(secondReminder.id, "approved");
  await syncGoogleCalendar({ client });
  state.setReminderStatus(secondReminder.id, "cancelled");
  await syncGoogleCalendar({ client });
  assert.deepEqual(calls.deleted, ["google-2"]);
});

test("refreshes OAuth and sends authenticated Calendar requests", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url: String(url), options });
    if (String(url).includes("oauth2.googleapis.com")) {
      return new Response(JSON.stringify({ access_token: "access", expires_in: 3600 }), { status: 200 });
    }
    return new Response(JSON.stringify({ items: [], nextSyncToken: "next" }), { status: 200 });
  };
  const client = createGoogleCalendarClient({
    config: {
      configured: true,
      calendarId: "calendar@example.test",
      clientId: "client",
      clientSecret: "secret",
      refreshToken: "refresh",
    },
    fetchImpl,
  });

  await client.listEvents({ now: new Date("2026-07-16T00:00:00.000Z") });
  assert.equal(requests.length, 2);
  assert.equal(requests[1].options.headers.authorization, "Bearer access");
  assert.match(requests[1].url, /calendar%40example\.test\/events/);
});
