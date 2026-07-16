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

test("restarts an expired sync token and consumes every result page", async () => {
  const calendarId = "pagination@example.test";
  state.setPlatformSetting(`google_calendar_sync_token:${calendarId}`, "expired-token");
  const calls = [];
  const expired = new Error("sync token expired");
  expired.status = 410;
  const client = {
    calendarId,
    async listEvents(options) {
      calls.push(options);
      if (options.syncToken === "expired-token") throw expired;
      if (!options.pageToken) {
        return {
          items: [{
            id: "page-one-event",
            status: "confirmed",
            summary: "첫 페이지",
            start: { dateTime: "2026-11-01T10:00:00+09:00" },
          }],
          nextPageToken: "page-two",
        };
      }
      return { items: [], nextSyncToken: "fresh-token" };
    },
    async insertEvent(event, eventId) { return { ...event, id: eventId }; },
    async updateEvent(eventId) { return { id: eventId }; },
    async deleteEvent() {},
  };

  await syncGoogleCalendar({ client, now: new Date("2026-07-16T01:00:00.000Z") });

  assert.equal(calls.length, 3);
  assert.equal(calls[0].syncToken, "expired-token");
  assert.equal(calls[1].syncToken, null);
  assert.equal(calls[2].pageToken, "page-two");
  assert.equal(state.getPlatformSetting(`google_calendar_sync_token:${calendarId}`), "fresh-token");
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
    async insertEvent(event, eventId) {
      calls.inserted.push({ event, eventId });
      insertedCount += 1;
      return { id: eventId || `google-${insertedCount}` };
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
  assert.equal(calls.inserted[0].event.summary, "서류 발표");
  assert.match(calls.inserted[0].eventId, /^lifedemon[0-9a-f]+$/);
  assert.equal(state.getReminder(reminder.id).google_event_id, calls.inserted[0].eventId);

  incoming = [{
    id: calls.inserted[0].eventId,
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

  incoming = [{ id: calls.inserted[0].eventId, status: "cancelled" }];
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
  incoming = [{
    id: "google-2",
    status: "confirmed",
    summary: "면접",
    start: { dateTime: "2026-08-01T10:00:00+09:00" },
  }];
  await syncGoogleCalendar({ client });
  assert.deepEqual(calls.deleted, [calls.inserted[1].eventId]);
  assert.equal(state.getReminder(secondReminder.id).status, "cancelled");
});

test("recovers idempotently when an insert succeeded upstream but its response was lost", async () => {
  const reminder = state.createReminder({
    title: "중복 방지 일정",
    dueAt: "2026-10-01T01:00:00.000Z",
    module: "global",
    entityKey: "manual:calendar-idempotency-test",
  });
  state.setReminderStatus(reminder.id, "approved");
  const calls = { inserted: [], updated: [] };
  const conflict = new Error("already exists");
  conflict.status = 409;
  const result = await syncGoogleCalendar({
    client: {
      calendarId: "idempotent@example.test",
      async listEvents() { return { items: [], nextSyncToken: "idempotent-token" }; },
      async insertEvent(event, eventId) {
        calls.inserted.push({ event, eventId });
        throw conflict;
      },
      async updateEvent(eventId, event) {
        calls.updated.push({ eventId, event });
        return { id: eventId };
      },
    },
  });

  assert.equal(result.created, 1);
  assert.equal(calls.inserted.length, 1);
  assert.equal(calls.updated.length, 1);
  assert.equal(calls.updated[0].eventId, calls.inserted[0].eventId);
  assert.equal(state.getReminder(reminder.id).google_event_id, calls.inserted[0].eventId);
});

test("recreates an event when a previously deleted Google event is approved again", async () => {
  const reminder = state.createReminder({
    title: "다시 승인할 일정",
    dueAt: "2026-12-01T01:00:00.000Z",
    module: "global",
    entityKey: "manual:calendar-reapprove-test",
  });
  state.setReminderStatus(reminder.id, "approved");
  let currentEventId = null;
  const inserted = [];
  const missing = new Error("not found");
  missing.status = 404;
  const client = {
    calendarId: "reapprove@example.test",
    async listEvents() { return { items: [], nextSyncToken: `reapprove-${Date.now()}` }; },
    async insertEvent(event, eventId) {
      inserted.push(eventId);
      currentEventId = eventId;
      return { ...event, id: eventId };
    },
    async updateEvent(eventId, event) {
      if (eventId !== currentEventId) throw missing;
      return { ...event, id: eventId };
    },
    async deleteEvent(eventId) {
      assert.equal(eventId, currentEventId);
      currentEventId = null;
    },
  };

  await syncGoogleCalendar({ client });
  const firstEventId = state.getReminder(reminder.id).google_event_id;
  state.setReminderStatus(reminder.id, "cancelled");
  await syncGoogleCalendar({ client });
  await new Promise((resolve) => setTimeout(resolve, 2));
  state.setReminderStatus(reminder.id, "approved");
  await syncGoogleCalendar({ client });

  assert.equal(inserted.length, 2);
  assert.notEqual(inserted[1], firstEventId);
  assert.equal(state.getReminder(reminder.id).google_event_id, inserted[1]);
});

test("preserves fired reminders when a past Google event is edited", async () => {
  const reminder = state.upsertReminderFromCalendar({
    calendarId: "history@example.test",
    eventId: "past-event",
    title: "지난 일정",
    dueAt: "2026-07-15T01:00:00.000Z",
    syncedAt: "2026-07-15T02:00:00.000Z",
  });
  state.markReminderFired(reminder.id);

  state.upsertReminderFromCalendar({
    calendarId: "history@example.test",
    eventId: "past-event",
    title: "지난 일정 메모 수정",
    dueAt: "2026-07-15T01:00:00.000Z",
    syncedAt: "2026-07-16T01:00:00.000Z",
  });

  assert.equal(state.getReminder(reminder.id).status, "fired");
  assert.equal(state.getReminder(reminder.id).title, "지난 일정 메모 수정");
});

test("reports partial push failures in calendar status", async () => {
  const reminder = state.createReminder({
    title: "실패할 일정",
    dueAt: "2026-09-01T01:00:00.000Z",
    module: "global",
    entityKey: "manual:calendar-failure-test",
  });
  state.setReminderStatus(reminder.id, "approved");
  const result = await syncGoogleCalendar({
    client: {
      calendarId: "failure@example.test",
      async listEvents() { return { items: [], nextSyncToken: "failure-token" }; },
      async insertEvent() { throw new Error("upstream unavailable"); },
    },
  });

  assert.equal(result.errors.length, 1);
  assert.match(state.getPlatformSetting("google_calendar_last_error"), /1 calendar push/);
  assert.equal(state.getReminder(reminder.id).calendar_sync_error, "upstream unavailable");
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
  assert.match(requests[1].url, /singleEvents=true/);

  requests.length = 0;
  await client.listEvents({ syncToken: "previous-sync-token" });
  assert.match(requests[0].url, /syncToken=previous-sync-token/);
  assert.match(requests[0].url, /singleEvents=true/);
});
