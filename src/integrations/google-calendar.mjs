import { createHash, randomUUID } from "node:crypto";
import {
  acquireCalendarSyncLease,
  cancelReminderFromCalendar,
  getPlatformSetting,
  markReminderCalendarSynced,
  markReminderCalendarSyncFailed,
  recordReminderCalendarEvent,
  reconcileRemindersFromCalendarSnapshot,
  releaseCalendarSyncLease,
  remindersNeedingCalendarSync,
  renewCalendarSyncLease,
  setPlatformSetting,
  upsertReminderFromCalendar,
} from "../core/state.mjs";

const calendarApiRoot = "https://www.googleapis.com/calendar/v3";
const oauthTokenUrl = "https://oauth2.googleapis.com/token";
const defaultSyncIntervalMs = 60_000;
const fullSyncIntervalMs = 7 * 86400_000;
const syncLeaseDurationMs = 5 * 60_000;

const clean = (value) => String(value || "").trim();

export function googleCalendarConfig(env = process.env) {
  const enabled = /^(1|true|yes)$/i.test(clean(env.GOOGLE_CALENDAR_ENABLED));
  const config = {
    enabled,
    calendarId: clean(env.GOOGLE_CALENDAR_ID),
    clientId: clean(env.GOOGLE_OAUTH_CLIENT_ID),
    clientSecret: clean(env.GOOGLE_OAUTH_CLIENT_SECRET),
    refreshToken: clean(env.GOOGLE_OAUTH_REFRESH_TOKEN),
    syncIntervalMs: Math.max(30_000, Number(env.GOOGLE_CALENDAR_SYNC_INTERVAL_MS) || defaultSyncIntervalMs),
  };
  config.configured = Boolean(
    config.enabled && config.calendarId && config.clientId
      && config.clientSecret && config.refreshToken,
  );
  return config;
}

export function calendarSyncStatus(env = process.env) {
  const config = googleCalendarConfig(env);
  return {
    enabled: config.enabled,
    configured: config.configured,
    calendarId: config.calendarId || null,
    lastSync: getPlatformSetting("google_calendar_last_sync"),
    lastError: getPlatformSetting("google_calendar_last_error"),
  };
}

export function eventStartToIso(start) {
  if (start?.dateTime) {
    const parsed = new Date(start.dateTime);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  if (start?.date && /^\d{4}-\d{2}-\d{2}$/.test(start.date)) {
    return new Date(`${start.date}T09:00:00+09:00`).toISOString();
  }
  return null;
}

function reminderToEvent(reminder) {
  const start = new Date(reminder.due_at);
  const end = new Date(start.getTime() + 30 * 60_000);
  const description = [
    "Life Daemon 전역 알림과 동기화된 일정입니다.",
    reminder.url ? `링크: ${reminder.url}` : null,
  ].filter(Boolean).join("\n");
  return {
    summary: reminder.title,
    description,
    start: { dateTime: start.toISOString(), timeZone: "Asia/Seoul" },
    end: { dateTime: end.toISOString(), timeZone: "Asia/Seoul" },
    reminders: { useDefault: true },
    extendedProperties: {
      private: {
        lifedemonManaged: "true",
        lifedemonReminderId: String(reminder.id),
      },
    },
  };
}

function reminderEventId(reminder) {
  const digest = createHash("sha256")
    .update(`${reminder.id}:${reminder.updated_at}`)
    .digest("hex")
    .slice(0, 32);
  return `lifedemon${digest}`;
}

async function insertEventIdempotently(client, eventBody, eventId) {
  try {
    return await client.insertEvent(eventBody, eventId);
  } catch (error) {
    if (error.status !== 409) throw error;
    return client.updateEvent(eventId, eventBody);
  }
}

function eventMetadata(event, calendarId) {
  return {
    source: "google-calendar",
    googleCalendarId: calendarId,
    googleEventId: event.id,
    googleEtag: event.etag || null,
    googleUpdatedAt: event.updated || null,
    allDay: Boolean(event.start?.date && !event.start?.dateTime),
  };
}

export function createGoogleCalendarClient({ config = googleCalendarConfig(), fetchImpl = globalThis.fetch } = {}) {
  if (!config.configured) throw new Error("Google Calendar is not configured");
  let token = null;
  let tokenExpiresAt = 0;

  async function accessToken() {
    if (token && Date.now() < tokenExpiresAt - 60_000) return token;
    const body = new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: config.refreshToken,
      grant_type: "refresh_token",
    });
    const response = await fetchImpl(oauthTokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(30_000),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.access_token) {
      throw new Error(`Google OAuth HTTP ${response.status}`);
    }
    token = payload.access_token;
    tokenExpiresAt = Date.now() + (Number(payload.expires_in) || 3600) * 1000;
    return token;
  }

  async function request(path, { method = "GET", body, allowNotFound = false } = {}) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetchImpl(`${calendarApiRoot}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${await accessToken()}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(45_000),
      });
      if (response.status === 401 && attempt === 0) {
        await response.arrayBuffer().catch(() => null);
        token = null;
        tokenExpiresAt = 0;
        continue;
      }
      if (allowNotFound && response.status === 404) return null;
      const payload = response.status === 204 ? null : await response.json().catch(() => null);
      if (!response.ok) {
        const error = new Error(`Google Calendar HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }
      return payload;
    }
    throw new Error("Google Calendar authentication retry failed");
  }

  const calendarPath = `/calendars/${encodeURIComponent(config.calendarId)}`;
  return {
    calendarId: config.calendarId,
    async listEvents({ syncToken = null, pageToken = null, now = new Date() } = {}) {
      const params = new URLSearchParams({
        maxResults: "2500",
        showDeleted: "true",
        singleEvents: "true",
      });
      if (pageToken) params.set("pageToken", pageToken);
      if (syncToken) {
        params.set("syncToken", syncToken);
      } else {
        params.set("timeMin", new Date(now.getTime() - 5 * 60_000).toISOString());
        params.set("timeMax", new Date(now.getTime() + 366 * 86400_000).toISOString());
      }
      return request(`${calendarPath}/events?${params}`);
    },
    insertEvent(event, eventId = null) {
      return request(`${calendarPath}/events`, {
        method: "POST",
        body: eventId ? { ...event, id: eventId } : event,
      });
    },
    updateEvent(eventId, event) {
      return request(`${calendarPath}/events/${encodeURIComponent(eventId)}`, { method: "PATCH", body: event });
    },
    deleteEvent(eventId) {
      return request(`${calendarPath}/events/${encodeURIComponent(eventId)}`, {
        method: "DELETE", allowNotFound: true,
      });
    },
  };
}
async function pullCalendarChanges(client, now, renewLease = () => {}) {
  const tokenKey = `google_calendar_sync_token:${client.calendarId}`;
  const fullSyncKey = `google_calendar_full_sync:${client.calendarId}`;
  let syncToken = getPlatformSetting(tokenKey);
  const lastFullSync = Date.parse(getPlatformSetting(fullSyncKey, ""));
  let performedFullSync = !syncToken
    || Number.isNaN(lastFullSync)
    || now.getTime() - lastFullSync >= fullSyncIntervalMs;
  if (performedFullSync) syncToken = null;
  let pageToken = null;
  let imported = 0;
  let cancelled = 0;
  const seenEventIds = new Set();
  const windowStart = new Date(now.getTime() - 5 * 60_000).toISOString();
  const windowEnd = new Date(now.getTime() + 366 * 86400_000).toISOString();

  for (;;) {
    renewLease();
    let page;
    try {
      page = await client.listEvents({ syncToken, pageToken, now });
    } catch (error) {
      if (error.status === 410 && syncToken) {
        setPlatformSetting(tokenKey, "");
        syncToken = null;
        performedFullSync = true;
        pageToken = null;
        continue;
      }
      throw error;
    }

    for (const event of page?.items || []) {
      if (!event?.id) continue;
      if (performedFullSync) seenEventIds.add(event.id);
      if (event.status === "cancelled") {
        cancelled += cancelReminderFromCalendar(client.calendarId, event.id) ? 1 : 0;
        continue;
      }
      const dueAt = eventStartToIso(event.start);
      if (!dueAt) continue;
      upsertReminderFromCalendar({
        calendarId: client.calendarId,
        eventId: event.id,
        title: clean(event.summary) || "(제목 없는 일정)",
        dueAt,
        url: event.htmlLink || null,
        metadata: eventMetadata(event, client.calendarId),
      });
      imported += 1;
    }

    pageToken = page?.nextPageToken || null;
    if (!pageToken) {
      if (performedFullSync) {
        cancelled += reconcileRemindersFromCalendarSnapshot({
          calendarId: client.calendarId,
          seenEventIds,
          windowStart,
          windowEnd,
          syncedAt: now.toISOString(),
        });
      }
      if (page?.nextSyncToken) setPlatformSetting(tokenKey, page.nextSyncToken);
      if (performedFullSync) setPlatformSetting(fullSyncKey, now.toISOString());
      break;
    }
  }
  return { imported, cancelled };
}

async function pushLocalChanges(client, renewLease = () => {}) {
  let created = 0;
  let updated = 0;
  let deleted = 0;
  const errors = [];

  for (const reminder of remindersNeedingCalendarSync(client.calendarId)) {
    renewLease();
    try {
      if (reminder.status === "cancelled" && reminder.google_event_id) {
        await client.deleteEvent(reminder.google_event_id);
        markReminderCalendarSynced(reminder.id, {
          expectedStatus: reminder.status,
          expectedUpdatedAt: reminder.updated_at,
        });
        deleted += 1;
      } else if (reminder.status === "approved") {
        const eventBody = reminderToEvent(reminder);
        let eventId = reminder.google_event_id || reminderEventId(reminder);
        let event;
        if (reminder.google_event_id) {
          try {
            event = await client.updateEvent(eventId, eventBody);
          } catch (error) {
            if (error.status !== 404) throw error;
            eventId = reminderEventId(reminder);
            event = await insertEventIdempotently(client, eventBody, eventId);
          }
        } else {
          event = await insertEventIdempotently(client, eventBody, eventId);
        }
        recordReminderCalendarEvent(reminder.id, client.calendarId, event?.id || eventId);
        markReminderCalendarSynced(reminder.id, {
          calendarId: client.calendarId,
          eventId: event?.id || eventId,
          expectedStatus: reminder.status,
          expectedUpdatedAt: reminder.updated_at,
        });
        if (reminder.google_event_id) updated += 1;
        else created += 1;
      }
    } catch (error) {
      markReminderCalendarSyncFailed(reminder.id, error.message);
      errors.push({ reminderId: reminder.id, error: error.message });
    }
  }
  return { created, updated, deleted, errors };
}

export async function syncGoogleCalendar({ client = null, now = new Date(), env = process.env } = {}) {
  const config = googleCalendarConfig(env);
  if (!client && !config.configured) return { skipped: true, reason: "not configured" };
  const activeClient = client || createGoogleCalendarClient({ config });
  const leaseOwner = randomUUID();
  const leaseExpiresAt = () => new Date(Date.now() + syncLeaseDurationMs).toISOString();
  if (!acquireCalendarSyncLease(
    activeClient.calendarId,
    leaseOwner,
    new Date().toISOString(),
    leaseExpiresAt(),
  )) {
    return { skipped: true, reason: "sync already running" };
  }
  const renewLease = () => {
    if (!renewCalendarSyncLease(activeClient.calendarId, leaseOwner, leaseExpiresAt())) {
      throw new Error("Google Calendar sync lease was lost");
    }
  };
  try {
    const pulled = await pullCalendarChanges(activeClient, now, renewLease);
    const pushed = await pushLocalChanges(activeClient, renewLease);
    const syncedAt = new Date().toISOString();
    setPlatformSetting("google_calendar_last_sync", syncedAt);
    setPlatformSetting(
      "google_calendar_last_error",
      pushed.errors.length ? `${pushed.errors.length} calendar push operation(s) failed` : "",
    );
    return { skipped: false, ...pulled, ...pushed, syncedAt };
  } catch (error) {
    setPlatformSetting("google_calendar_last_error", error.message);
    throw error;
  } finally {
    releaseCalendarSyncLease(activeClient.calendarId, leaseOwner);
  }
}
