import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const dataDir = process.env.MONITOR_DATA_DIR || "/data/crawler/data";
mkdirSync(dataDir, { recursive: true });

export const platformDb = new DatabaseSync(`${dataDir}/platform.sqlite`);
const db = platformDb;
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
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

  CREATE TABLE IF NOT EXISTS calendar_sync_leases (
    calendar_id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS feedback_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    signal TEXT NOT NULL,
    subject_type TEXT,
    subject_value TEXT,
    raw_text TEXT,
    metadata_json TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS feedback_rule_proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain TEXT NOT NULL,
    kind TEXT NOT NULL,
    keyword TEXT NOT NULL,
    instruction TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'proposed',
    source_event_id INTEGER,
    target_ref TEXT,
    created_at TEXT NOT NULL,
    decided_at TEXT
  );

  CREATE TABLE IF NOT EXISTS feedback_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain TEXT NOT NULL,
    kind TEXT NOT NULL,
    keyword TEXT NOT NULL,
    instruction TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    UNIQUE(domain, kind, keyword)
  );

  CREATE TABLE IF NOT EXISTS telegram_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    method TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    dedupe_key TEXT NOT NULL UNIQUE,
    context_json TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    available_at TEXT NOT NULL,
    claimed_at TEXT,
    last_error TEXT,
    result_json TEXT,
    message_id INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    delivered_at TEXT
  );

  CREATE INDEX IF NOT EXISTS telegram_outbox_due
  ON telegram_outbox(status, available_at);
`);

db.exec("BEGIN IMMEDIATE");
try {
  const reminderColumns = new Set(db.prepare("PRAGMA table_info(reminders)").all().map((column) => column.name));
  if (!reminderColumns.has("resolver")) db.exec("ALTER TABLE reminders ADD COLUMN resolver TEXT");
  if (!reminderColumns.has("metadata_json")) db.exec("ALTER TABLE reminders ADD COLUMN metadata_json TEXT");
  if (!reminderColumns.has("google_calendar_id")) db.exec("ALTER TABLE reminders ADD COLUMN google_calendar_id TEXT");
  if (!reminderColumns.has("google_event_id")) db.exec("ALTER TABLE reminders ADD COLUMN google_event_id TEXT");
  if (!reminderColumns.has("calendar_synced_at")) db.exec("ALTER TABLE reminders ADD COLUMN calendar_synced_at TEXT");
  if (!reminderColumns.has("calendar_sync_error")) db.exec("ALTER TABLE reminders ADD COLUMN calendar_sync_error TEXT");
  const feedbackColumns = new Set(db.prepare("PRAGMA table_info(feedback_events)").all().map((column) => column.name));
  if (!feedbackColumns.has("reverted_at")) db.exec("ALTER TABLE feedback_events ADD COLUMN reverted_at TEXT");
  if (!feedbackColumns.has("revert_text")) db.exec("ALTER TABLE feedback_events ADD COLUMN revert_text TEXT");
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS reminders_google_event
    ON reminders(google_calendar_id, google_event_id)
    WHERE google_calendar_id IS NOT NULL AND google_event_id IS NOT NULL;
  `);
  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
}

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

const feedbackSignals = new Set(["positive", "negative", "applied", "ignored"]);

export function recordFeedbackEvent({
  domain, entityId, signal, subjectType = null, subjectValue = null,
  rawText = null, metadata = null,
}) {
  if (!domain || !entityId || !feedbackSignals.has(signal)) throw new Error("invalid feedback event");
  const metadataJson = metadata ? JSON.stringify(metadata).slice(0, 4000) : null;
  const result = db.prepare(`
    INSERT INTO feedback_events(
      domain, entity_id, signal, subject_type, subject_value,
      raw_text, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    String(domain), String(entityId), signal,
    subjectType ? String(subjectType) : null,
    subjectValue ? String(subjectValue) : null,
    rawText ? String(rawText).slice(0, 1000) : null,
    metadataJson,
    now(),
  );
  return db.prepare("SELECT * FROM feedback_events WHERE id=?").get(result.lastInsertRowid);
}

export function recentFeedbackEvents(limit = 20) {
  return db.prepare(`
    SELECT * FROM feedback_events WHERE reverted_at IS NULL ORDER BY id DESC LIMIT ?
  `).all(Math.max(1, Math.min(100, Number(limit) || 20)));
}

export function latestFeedbackEvent({ domain = null, entityId = null } = {}) {
  return db.prepare(`
    SELECT * FROM feedback_events
    WHERE reverted_at IS NULL
      AND (? IS NULL OR domain=?)
      AND (? IS NULL OR entity_id=?)
    ORDER BY id DESC LIMIT 1
  `).get(domain, domain, entityId, entityId) || null;
}

export function revertFeedbackEvent(id, text = null) {
  return db.prepare(`
    UPDATE feedback_events SET reverted_at=?, revert_text=?
    WHERE id=? AND reverted_at IS NULL
  `).run(now(), text ? String(text).slice(0, 1000) : null, id).changes > 0;
}

export function feedbackRuleProposalForEvent(eventId) {
  return db.prepare(`
    SELECT * FROM feedback_rule_proposals
    WHERE source_event_id=? ORDER BY id DESC LIMIT 1
  `).get(eventId) || null;
}

export function createFeedbackRuleProposal({
  domain, kind, keyword, instruction, sourceEventId = null,
}) {
  const existing = db.prepare(`
    SELECT * FROM feedback_rule_proposals
    WHERE domain=? AND kind=? AND keyword=? AND status='proposed'
    ORDER BY id DESC LIMIT 1
  `).get(domain, kind, keyword);
  if (existing) return existing;
  const result = db.prepare(`
    INSERT INTO feedback_rule_proposals(
      domain, kind, keyword, instruction, status, source_event_id, created_at
    ) VALUES (?, ?, ?, ?, 'proposed', ?, ?)
  `).run(domain, kind, keyword, instruction, sourceEventId, now());
  return db.prepare("SELECT * FROM feedback_rule_proposals WHERE id=?").get(result.lastInsertRowid);
}

export function getFeedbackRuleProposal(id) {
  return db.prepare("SELECT * FROM feedback_rule_proposals WHERE id=?").get(id) || null;
}

export function decideFeedbackRuleProposal(id, status, targetRef = null) {
  if (!["approved", "rejected"].includes(status)) throw new Error("invalid feedback proposal status");
  return db.prepare(`
    UPDATE feedback_rule_proposals
    SET status=?, target_ref=?, decided_at=?
    WHERE id=? AND status='proposed'
  `).run(status, targetRef, now(), id).changes > 0;
}

export function addFeedbackRule({ domain, kind, keyword, instruction }) {
  db.prepare(`
    INSERT INTO feedback_rules(domain, kind, keyword, instruction, enabled, created_at)
    VALUES (?, ?, ?, ?, 1, ?)
    ON CONFLICT(domain, kind, keyword) DO UPDATE SET
      instruction=excluded.instruction, enabled=1
  `).run(domain, kind, keyword, instruction, now());
  return db.prepare(`
    SELECT * FROM feedback_rules WHERE domain=? AND kind=? AND keyword=?
  `).get(domain, kind, keyword);
}

export function listFeedbackRules(domain = null, kind = null) {
  return db.prepare(`
    SELECT * FROM feedback_rules
    WHERE enabled=1 AND (? IS NULL OR domain=?) AND (? IS NULL OR kind=?)
    ORDER BY id
  `).all(domain, domain, kind, kind);
}

export function disableFeedbackRule(id) {
  return db.prepare("UPDATE feedback_rules SET enabled=0 WHERE id=? AND enabled=1").run(id).changes > 0;
}

export function enqueueTelegramOutbox({ method, payload, dedupeKey, context = null }) {
  const timestamp = now();
  db.prepare(`
    INSERT INTO telegram_outbox(
      method, payload_json, dedupe_key, context_json, status,
      available_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)
    ON CONFLICT(dedupe_key) DO NOTHING
  `).run(
    method, JSON.stringify(payload), dedupeKey,
    context ? JSON.stringify(context).slice(0, 20_000) : null,
    timestamp, timestamp, timestamp,
  );
  return db.prepare("SELECT * FROM telegram_outbox WHERE dedupe_key=?").get(dedupeKey);
}

export function claimTelegramOutbox({ id = null, at = now(), staleBefore = null } = {}) {
  const stale = staleBefore || new Date(Date.parse(at) - 5 * 60_000).toISOString();
  db.prepare(`
    UPDATE telegram_outbox
    SET status='pending', claimed_at=NULL, available_at=?, updated_at=?
    WHERE status='sending' AND claimed_at<=?
  `).run(at, at, stale);
  const row = id == null
    ? db.prepare(`
      SELECT * FROM telegram_outbox
      WHERE status='pending' AND available_at<=?
      ORDER BY id LIMIT 1
    `).get(at)
    : db.prepare("SELECT * FROM telegram_outbox WHERE id=? AND status='pending'").get(id);
  if (!row) return null;
  const claimed = db.prepare(`
    UPDATE telegram_outbox
    SET status='sending', attempts=attempts+1, claimed_at=?, updated_at=?
    WHERE id=? AND status='pending'
  `).run(at, at, row.id).changes;
  return claimed ? db.prepare("SELECT * FROM telegram_outbox WHERE id=?").get(row.id) : null;
}

export function completeTelegramOutbox(id, result) {
  const timestamp = now();
  const messageId = Number.isFinite(Number(result?.message_id)) ? Number(result.message_id) : null;
  db.prepare(`
    UPDATE telegram_outbox
    SET status='delivered', result_json=?, message_id=?, delivered_at=?,
        claimed_at=NULL, last_error=NULL, updated_at=?
    WHERE id=? AND status='sending'
  `).run(JSON.stringify(result ?? null), messageId, timestamp, timestamp, id);
  return db.prepare("SELECT * FROM telegram_outbox WHERE id=?").get(id);
}

export function rescheduleTelegramOutbox(id, error, delayMs = 30_000) {
  const timestamp = now();
  const availableAt = new Date(Date.now() + Math.max(1_000, delayMs)).toISOString();
  db.prepare(`
    UPDATE telegram_outbox
    SET status='pending', available_at=?, claimed_at=NULL, last_error=?, updated_at=?
    WHERE id=? AND status='sending'
  `).run(availableAt, String(error || "Telegram delivery failed").slice(0, 1000), timestamp, id);
}

export function failTelegramOutbox(id, error) {
  const timestamp = now();
  db.prepare(`
    UPDATE telegram_outbox
    SET status='failed', claimed_at=NULL, last_error=?, updated_at=?
    WHERE id=? AND status='sending'
  `).run(String(error || "Telegram delivery failed").slice(0, 1000), timestamp, id);
}

export function getTelegramOutbox(id) {
  return db.prepare("SELECT * FROM telegram_outbox WHERE id=?").get(id) || null;
}

export function telegramMessageContext(messageId) {
  const row = db.prepare(`
    SELECT context_json FROM telegram_outbox
    WHERE status='delivered' AND message_id=? AND context_json IS NOT NULL
    ORDER BY id DESC LIMIT 1
  `).get(messageId);
  if (!row) return null;
  try { return JSON.parse(row.context_json); } catch { return null; }
}

export function telegramOutboxHealth() {
  const counts = Object.fromEntries(db.prepare(`
    SELECT status, COUNT(*) AS count FROM telegram_outbox GROUP BY status
  `).all().map((row) => [row.status, row.count]));
  const oldest = db.prepare(`
    SELECT created_at, last_error FROM telegram_outbox
    WHERE status IN ('pending', 'sending', 'failed') ORDER BY id LIMIT 1
  `).get() || null;
  return { counts, oldest };
}

export function acquireCalendarSyncLease(calendarId, owner, acquiredAt, expiresAt) {
  return db.prepare(`
    INSERT INTO calendar_sync_leases(calendar_id, owner, expires_at)
    VALUES (?, ?, ?)
    ON CONFLICT(calendar_id) DO UPDATE SET
      owner=excluded.owner, expires_at=excluded.expires_at
    WHERE calendar_sync_leases.expires_at<=?
  `).run(calendarId, owner, expiresAt, acquiredAt).changes > 0;
}

export function renewCalendarSyncLease(calendarId, owner, expiresAt) {
  return db.prepare(`
    UPDATE calendar_sync_leases SET expires_at=?
    WHERE calendar_id=? AND owner=?
  `).run(expiresAt, calendarId, owner).changes > 0;
}

export function releaseCalendarSyncLease(calendarId, owner) {
  return db.prepare(`
    DELETE FROM calendar_sync_leases WHERE calendar_id=? AND owner=?
  `).run(calendarId, owner).changes > 0;
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

export function cancelRemindersForEntity(module, entityKeyPrefix) {
  const timestamp = now();
  return db.prepare(`
    UPDATE reminders SET status='cancelled', updated_at=?
    WHERE module=? AND entity_key LIKE ? AND status IN ('proposed', 'approved')
  `).run(timestamp, module, `${entityKeyPrefix}%`).changes;
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
  expectedStatus = null, expectedUpdatedAt = null,
} = {}) {
  return db.prepare(`
    UPDATE reminders
    SET google_calendar_id=COALESCE(?, google_calendar_id),
        google_event_id=COALESCE(?, google_event_id),
        calendar_synced_at=?, calendar_sync_error=?
    WHERE id=?
      AND (? IS NULL OR status=?)
      AND (? IS NULL OR updated_at=?)
  `).run(
    calendarId || null, eventId || null, syncedAt, error, id,
    expectedStatus, expectedStatus, expectedUpdatedAt, expectedUpdatedAt,
  ).changes > 0;
}

export function recordReminderCalendarEvent(id, calendarId, eventId) {
  return db.prepare(`
    UPDATE reminders
    SET google_calendar_id=?, google_event_id=?
    WHERE id=?
  `).run(calendarId, eventId, id).changes > 0;
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
    SELECT id, status, updated_at, calendar_synced_at, metadata_json
    FROM reminders WHERE google_calendar_id=? AND google_event_id=?
  `).get(calendarId, eventId);

  if (existing) {
    const hasPendingLocalCancellation = existing.status === "cancelled"
      && (!existing.calendar_synced_at || existing.updated_at > existing.calendar_synced_at);
    if (hasPendingLocalCancellation) return getReminder(existing.id);

    const nextStatus = existing.status === "fired" && dueAt <= timestamp
      ? "fired"
      : "approved";
    let existingMetadata = {};
    try {
      const parsed = JSON.parse(existing.metadata_json || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) existingMetadata = parsed;
    } catch { /* replace malformed legacy metadata with valid sync metadata */ }
    const mergedMetadata = metadata
      ? { ...existingMetadata, ...metadata }
      : existingMetadata;
    const result = db.prepare(`
      UPDATE reminders
      SET title=?, due_at=?, url=COALESCE(url, ?), metadata_json=?, status=?,
          calendar_synced_at=?, calendar_sync_error=NULL, updated_at=?
      WHERE id=? AND status=? AND updated_at=?
    `).run(
      title, dueAt, url, Object.keys(mergedMetadata).length ? JSON.stringify(mergedMetadata) : null, nextStatus,
      timestamp, timestamp, existing.id, existing.status, existing.updated_at,
    );
    if (!result.changes) return getReminder(existing.id);
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
      AND NOT (
        status='approved'
        AND (calendar_synced_at IS NULL OR updated_at>calendar_synced_at)
      )
  `).run(syncedAt, syncedAt, calendarId, eventId).changes > 0;
}

export function reconcileRemindersFromCalendarSnapshot({
  calendarId, seenEventIds, windowStart, windowEnd, syncedAt = now(),
}) {
  const seen = new Set(seenEventIds);
  const candidates = db.prepare(`
    SELECT id, status, updated_at, calendar_synced_at, google_event_id
    FROM reminders
    WHERE google_calendar_id=? AND google_event_id IS NOT NULL
      AND status='approved' AND due_at>=? AND due_at<=?
  `).all(calendarId, windowStart, windowEnd);
  let cancelled = 0;
  for (const reminder of candidates) {
    if (seen.has(reminder.google_event_id)) continue;
    if (!reminder.calendar_synced_at || reminder.updated_at > reminder.calendar_synced_at) continue;
    cancelled += db.prepare(`
      UPDATE reminders
      SET status='cancelled', calendar_synced_at=?, calendar_sync_error=NULL, updated_at=?
      WHERE id=? AND status=? AND updated_at=?
    `).run(
      syncedAt, syncedAt, reminder.id, reminder.status, reminder.updated_at,
    ).changes;
  }
  return cancelled;
}
