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
  const stale = state.upsertReminderFromCalendar({
    calendarId,
    eventId: "deleted-while-token-expired",
    title: "삭제된 일정",
    dueAt: "2026-11-02T10:00:00.000Z",
    syncedAt: "2026-07-15T01:00:00.000Z",
  });
  state.setPlatformSetting(`google_calendar_sync_token:${calendarId}`, "expired-token");
  state.setPlatformSetting(`google_calendar_full_sync:${calendarId}`, "2026-07-15T01:00:00.000Z");
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
  assert.equal(state.getReminder(stale.id).status, "cancelled");
  assert.equal(
    state.getPlatformSetting(`google_calendar_full_sync:${calendarId}`),
    "2026-07-16T01:00:00.000Z",
  );
});

test("periodically rebases the bounded full-sync window", async () => {
  const calendarId = "rolling-window@example.test";
  const pendingLocal = state.upsertReminderFromCalendar({
    calendarId,
    eventId: "pending-local-event",
    title: "로컬 수정 보존",
    dueAt: "2026-10-01T00:00:00.000Z",
    syncedAt: "2026-07-01T00:00:00.000Z",
  });
  state.setReminderStatus(pendingLocal.id, "approved");
  state.setPlatformSetting(`google_calendar_sync_token:${calendarId}`, "old-window-token");
  state.setPlatformSetting(`google_calendar_full_sync:${calendarId}`, "2026-07-01T00:00:00.000Z");
  const calls = [];
  await syncGoogleCalendar({
    now: new Date("2026-07-16T00:00:00.000Z"),
    client: {
      calendarId,
      async listEvents(options) {
        calls.push(options);
        return { items: [], nextSyncToken: "rebased-token" };
      },
    },
  });

  assert.equal(calls[0].syncToken, null);
  assert.equal(state.getPlatformSetting(`google_calendar_sync_token:${calendarId}`), "rebased-token");
  assert.equal(state.getReminder(pendingLocal.id).status, "approved");
});

test("allows only one synchronization per calendar across workers", async () => {
  let entered;
  let release;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  const releasePromise = new Promise((resolve) => { release = resolve; });
  const client = {
    calendarId: "lease@example.test",
    async listEvents() {
      entered();
      await releasePromise;
      return { items: [], nextSyncToken: "lease-token" };
    },
  };

  const first = syncGoogleCalendar({ client });
  await enteredPromise;
  const second = await syncGoogleCalendar({ client });
  assert.deepEqual(second, { skipped: true, reason: "sync already running" });
  release();
  assert.equal((await first).skipped, false);
});

test("synchronizes local approvals and Google edits/deletes in both directions", async () => {
  const reminder = state.createReminder({
    title: "서류 발표",
    dueAt: "2026-07-20T07:00:00.000Z",
    url: "https://example.test/result",
    module: "global",
    entityKey: "manual:calendar-test",
    metadata: { source: "telegram-ai", originalText: "발표 알려줘" },
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
  assert.equal(JSON.parse(state.getReminder(reminder.id).metadata_json).originalText, "발표 알려줘");
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

test("keeps a concurrent cancellation pending after creating its Google event", async () => {
  const reminder = state.createReminder({
    title: "동시 취소 테스트",
    dueAt: "2026-12-20T07:00:00.000Z",
    module: "global",
    entityKey: "manual:calendar-cancel-race",
  });
  state.setReminderStatus(reminder.id, "approved");

  const deleted = [];
  const client = {
    calendarId: "cancel-race@example.test",
    async listEvents() { return { items: [], nextSyncToken: `race-${Date.now()}` }; },
    async insertEvent(_event, eventId) {
      state.setReminderStatus(reminder.id, "cancelled");
      return { id: eventId };
    },
    async updateEvent(eventId) { return { id: eventId }; },
    async deleteEvent(eventId) { deleted.push(eventId); },
  };

  await syncGoogleCalendar({ client });
  const afterCreate = state.getReminder(reminder.id);
  assert.equal(afterCreate.status, "cancelled");
  assert.ok(afterCreate.google_event_id, "the created event must remain tracked");
  assert.equal(afterCreate.calendar_synced_at, null, "the concurrent cancellation must remain pending");

  await syncGoogleCalendar({ client });
  assert.deepEqual(deleted, [afterCreate.google_event_id]);
  assert.ok(state.getReminder(reminder.id).calendar_synced_at);
});

test("tracks the replacement event when cancellation races with 404 recreation", async () => {
  const reminder = state.upsertReminderFromCalendar({
    calendarId: "replace-race@example.test",
    eventId: "missing-old-event",
    title: "교체 중 취소",
    dueAt: "2026-12-22T07:00:00.000Z",
    syncedAt: "2026-07-01T00:00:00.000Z",
  });
  state.setReminderStatus(reminder.id, "approved");
  const missing = new Error("not found");
  missing.status = 404;
  let replacementId = null;
  const deleted = [];
  const client = {
    calendarId: "replace-race@example.test",
    async listEvents() { return { items: [], nextSyncToken: `replace-${Date.now()}` }; },
    async updateEvent() { throw missing; },
    async insertEvent(_event, eventId) {
      replacementId = eventId;
      state.setReminderStatus(reminder.id, "cancelled");
      return { id: eventId };
    },
    async deleteEvent(eventId) { deleted.push(eventId); },
  };

  await syncGoogleCalendar({ client });
  assert.equal(state.getReminder(reminder.id).google_event_id, replacementId);
  await syncGoogleCalendar({ client });
  assert.deepEqual(deleted, [replacementId]);
});

test("does not let a stale Google deletion overwrite a pending local reapproval", () => {
  const reminder = state.upsertReminderFromCalendar({
    calendarId: "delete-race@example.test",
    eventId: "delete-race-event",
    title: "다시 승인됨",
    dueAt: "2026-12-24T07:00:00.000Z",
    syncedAt: "2026-07-01T00:00:00.000Z",
  });
  state.setReminderStatus(reminder.id, "approved");

  assert.equal(state.cancelReminderFromCalendar("delete-race@example.test", "delete-race-event"), false);
  assert.equal(state.getReminder(reminder.id).status, "approved");
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

test("refreshes and retries once when Google rejects a cached access token", async () => {
  const requests = [];
  let tokenNumber = 0;
  let calendarCalls = 0;
  const fetchImpl = async (url, options) => {
    requests.push({ url: String(url), options });
    if (String(url).includes("oauth2.googleapis.com")) {
      tokenNumber += 1;
      return new Response(JSON.stringify({ access_token: `access-${tokenNumber}`, expires_in: 3600 }), { status: 200 });
    }
    calendarCalls += 1;
    if (calendarCalls === 1) return new Response("unauthorized", { status: 401 });
    return new Response(JSON.stringify({ items: [], nextSyncToken: "next" }), { status: 200 });
  };
  const client = createGoogleCalendarClient({
    config: {
      configured: true,
      calendarId: "retry@example.test",
      clientId: "client",
      clientSecret: "secret",
      refreshToken: "refresh",
    },
    fetchImpl,
  });

  await client.listEvents();
  assert.equal(tokenNumber, 2);
  assert.equal(calendarCalls, 2);
  assert.equal(requests.at(-1).options.headers.authorization, "Bearer access-2");
});
