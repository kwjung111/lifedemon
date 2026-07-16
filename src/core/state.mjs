import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const dataDir = process.env.MONITOR_DATA_DIR || "/data/crawler/data";
mkdirSync(dataDir, { recursive: true });

export const platformDb = new DatabaseSync(`${dataDir}/platform.sqlite`);
const db = platformDb;
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    due_at TEXT NOT NULL,
    url TEXT,
    module TEXT NOT NULL DEFAULT 'global',
    entity_key TEXT,
    resolver TEXT,
    metadata_json TEXT,
    status TEXT NOT NULL DEFAULT 'proposed',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    fired_at TEXT,
    UNIQUE(module, entity_key, due_at)
  );
`);

const reminderColumns = new Set(db.prepare("PRAGMA table_info(reminders)").all().map((column) => column.name));
if (!reminderColumns.has("resolver")) db.exec("ALTER TABLE reminders ADD COLUMN resolver TEXT");
if (!reminderColumns.has("metadata_json")) db.exec("ALTER TABLE reminders ADD COLUMN metadata_json TEXT");
if (!reminderColumns.has("google_calendar_id")) db.exec("ALTER TABLE reminders ADD COLUMN google_calendar_id TEXT");
if (!reminderColumns.has("google_event_id")) db.exec("ALTER TABLE reminders ADD COLUMN google_event_id TEXT");
if (!reminderColumns.has("calendar_synced_at")) db.exec("ALTER TABLE reminders ADD COLUMN calendar_synced_at TEXT");
if (!reminderColumns.has("calendar_sync_error")) db.exec("ALTER TABLE reminders ADD COLUMN calendar_sync_error TEXT");
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS reminders_google_event
  ON reminders(google_calendar_id, google_event_id)
  WHERE google_calendar_id IS NOT NULL AND google_event_id IS NOT NULL;
`);

const now = () => new Date().toISOString();

export function getPlatformSetting(key, fallback = null) {
  return db.prepare("SELECT value FROM settings WHERE key=?").get(key)?.value ?? fallback;
}

export function setPlatformSetting(key, value) {
  db.prepare(`
    INSERT INTO settings(key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `).run(key, String(value));
}

export function createReminder({
  title, dueAt, url = null, module = "global", entityKey = null,
  resolver = null, metadata = null,
}) {
  const timestamp = now();
  db.prepare(`
    INSERT INTO reminders(
      title, due_at, url, module, entity_key, resolver, metadata_json,
      status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?)
    ON CONFLICT(module, entity_key, due_at) DO UPDATE SET
      title=excluded.title, url=excluded.url, resolver=excluded.resolver,
      metadata_json=excluded.metadata_json, updated_at=excluded.updated_at
  `).run(
    title, dueAt, url, module, entityKey, resolver,
    metadata ? JSON.stringify(metadata) : null, timestamp, timestamp,
  );
  return db.prepare(`
    SELECT * FROM reminders
    WHERE module=? AND entity_key IS ? AND due_at=?
  `).get(module, entityKey, dueAt);
}

export function getReminder(id) {
  return db.prepare("SELECT * FROM reminders WHERE id=?").get(id);
}

export function setReminderStatus(id, status) {
  return db.prepare(`
    UPDATE reminders SET status=?, updated_at=? WHERE id=?
  `).run(status, now(), id).changes > 0;
}

export function listReminders() {
  return db.prepare(`
    SELECT * FROM reminders
    WHERE status IN ('proposed', 'approved')
    ORDER BY due_at ASC
  `).all();
}

export function dueReminders(at = now()) {
  return db.prepare(`
    SELECT * FROM reminders
    WHERE status='approved' AND due_at<=?
    ORDER BY due_at ASC
  `).all(at);
}

export function markReminderFired(id) {
  const timestamp = now();
  db.prepare(`
    UPDATE reminders SET status='fired', fired_at=?, updated_at=? WHERE id=?
  `).run(timestamp, timestamp, id);
}

export function remindersNeedingCalendarSync(calendarId) {
  return db.prepare(`
    SELECT * FROM reminders
    WHERE module='global'
      AND (
        (status='approved' AND google_event_id IS NULL)
        OR (
          google_calendar_id=? AND google_event_id IS NOT NULL
          AND status IN ('approved', 'cancelled')
          AND (calendar_synced_at IS NULL OR updated_at>calendar_synced_at)
        )
      )
    ORDER BY updated_at ASC
  `).all(calendarId);
}

export function markReminderCalendarSynced(id, {
  calendarId, eventId, syncedAt = now(), error = null,
} = {}) {
  return db.prepare(`
    UPDATE reminders
    SET google_calendar_id=COALESCE(?, google_calendar_id),
        google_event_id=COALESCE(?, google_event_id),
        calendar_synced_at=?, calendar_sync_error=?
    WHERE id=?
  `).run(calendarId || null, eventId || null, syncedAt, error, id).changes > 0;
}

export function markReminderCalendarSyncFailed(id, message) {
  return db.prepare(`
    UPDATE reminders SET calendar_sync_error=? WHERE id=?
  `).run(String(message || "Calendar sync failed").slice(0, 1000), id).changes > 0;
}

export function upsertReminderFromCalendar({
  calendarId, eventId, title, dueAt, url = null, metadata = null,
  syncedAt = null,
}) {
  const timestamp = syncedAt || now();
  const existing = db.prepare(`
    SELECT id FROM reminders WHERE google_calendar_id=? AND google_event_id=?
  `).get(calendarId, eventId);

  if (existing) {
    db.prepare(`
      UPDATE reminders
      SET title=?, due_at=?, url=COALESCE(url, ?), metadata_json=?, status='approved',
          calendar_synced_at=?, calendar_sync_error=NULL, updated_at=?
      WHERE id=?
    `).run(
      title, dueAt, url, metadata ? JSON.stringify(metadata) : null,
      timestamp, timestamp, existing.id,
    );
    return getReminder(existing.id);
  }

  const result = db.prepare(`
    INSERT INTO reminders(
      title, due_at, url, module, entity_key, metadata_json, status,
      google_calendar_id, google_event_id, calendar_synced_at,
      created_at, updated_at
    ) VALUES (?, ?, ?, 'global', ?, ?, 'approved', ?, ?, ?, ?, ?)
  `).run(
    title, dueAt, url, `gcal:${calendarId}:${eventId}`,
    metadata ? JSON.stringify(metadata) : null,
    calendarId, eventId, timestamp, timestamp, timestamp,
  );
  return getReminder(Number(result.lastInsertRowid));
}

export function cancelReminderFromCalendar(calendarId, eventId, syncedAt = now()) {
  return db.prepare(`
    UPDATE reminders
    SET status='cancelled', calendar_synced_at=?, calendar_sync_error=NULL, updated_at=?
    WHERE google_calendar_id=? AND google_event_id=?
  `).run(syncedAt, syncedAt, calendarId, eventId).changes > 0;
}
