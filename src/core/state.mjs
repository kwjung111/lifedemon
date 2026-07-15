import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const dataDir = process.env.MONITOR_DATA_DIR || "/data/crawler/data";
mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(`${dataDir}/platform.sqlite`);
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
