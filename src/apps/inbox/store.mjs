import { platformDb } from "../../core/state.mjs";

const db = platformDb;
db.exec(`
  CREATE TABLE IF NOT EXISTS inbox_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    source_text TEXT,
    source_url TEXT,
    event_at TEXT,
    next_action TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    assumptions_json TEXT,
    attachment_json TEXT,
    classifier TEXT NOT NULL,
    source_message_id INTEGER UNIQUE,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS inbox_items_active
  ON inbox_items(status, event_at, updated_at);

  CREATE TABLE IF NOT EXISTS inbox_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL,
    snapshot_json TEXT NOT NULL,
    reason TEXT NOT NULL,
    source_message_id INTEGER,
    created_at TEXT NOT NULL,
    FOREIGN KEY(item_id) REFERENCES inbox_items(id)
  );

  CREATE TABLE IF NOT EXISTS inbox_classifier_usage (
    usage_date TEXT PRIMARY KEY,
    rule_calls INTEGER NOT NULL DEFAULT 0,
    ai_calls INTEGER NOT NULL DEFAULT 0,
    input_chars INTEGER NOT NULL DEFAULT 0,
    output_chars INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );
`);

const now = () => new Date().toISOString();
const clean = (value, max = 1000) => value == null ? null : String(value).replace(/\s+/g, " ").trim().slice(0, max);
const json = (value) => value == null ? null : JSON.stringify(value);

export function decodeInboxItem(row) {
  if (!row) return null;
  const parse = (value, fallback) => {
    try { return JSON.parse(value || "null") ?? fallback; } catch { return fallback; }
  };
  return {
    ...row,
    assumptions: parse(row.assumptions_json, []),
    attachment: parse(row.attachment_json, null),
  };
}

export function createInboxItem({
  kind, title, sourceText = null, sourceUrl = null, eventAt = null,
  nextAction, assumptions = [], attachment = null, classifier = "rules",
  sourceMessageId = null,
}) {
  const timestamp = now();
  const result = db.prepare(`
    INSERT OR IGNORE INTO inbox_items(
      kind, title, source_text, source_url, event_at, next_action,
      assumptions_json, attachment_json, classifier, source_message_id,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    kind, clean(title, 300), clean(sourceText, 4000), clean(sourceUrl, 2000), eventAt,
    clean(nextAction, 500) || "내용 확인", json(assumptions.slice(0, 6)), json(attachment),
    classifier, sourceMessageId == null ? null : Number(sourceMessageId), timestamp, timestamp,
  );
  const row = result.changes
    ? db.prepare("SELECT * FROM inbox_items WHERE id=?").get(result.lastInsertRowid)
    : db.prepare("SELECT * FROM inbox_items WHERE source_message_id=?").get(Number(sourceMessageId));
  return decodeInboxItem(row);
}

export function getInboxItem(id) {
  return decodeInboxItem(db.prepare("SELECT * FROM inbox_items WHERE id=?").get(Number(id)));
}

export function inboxItemForSourceMessage(sourceMessageId) {
  return decodeInboxItem(db.prepare("SELECT * FROM inbox_items WHERE source_message_id=?").get(Number(sourceMessageId)));
}

export function latestInboxItem({ activeOnly = false } = {}) {
  const row = db.prepare(`
    SELECT * FROM inbox_items
    WHERE (?=0 OR status='active')
    ORDER BY updated_at DESC, id DESC LIMIT 1
  `).get(activeOnly ? 1 : 0);
  return decodeInboxItem(row);
}

export function listInboxItems({ status = "active", limit = 20, offset = 0 } = {}) {
  return db.prepare(`
    SELECT * FROM inbox_items
    WHERE (? IS NULL OR status=?)
    ORDER BY
      CASE
        WHEN event_at>=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          AND event_at<=strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+7 days') THEN 0
        WHEN event_at IS NULL THEN 1
        WHEN event_at>strftime('%Y-%m-%dT%H:%M:%fZ', 'now') THEN 2
        ELSE 3
      END,
      event_at ASC,
      updated_at DESC
    LIMIT ? OFFSET ?
  `).all(
    status, status,
    Math.max(1, Math.min(100, Number(limit) || 20)),
    Math.max(0, Number(offset) || 0),
  ).map(decodeInboxItem);
}

export function countInboxItems(status = "active") {
  return Number(db.prepare(`
    SELECT COUNT(*) AS count FROM inbox_items WHERE (? IS NULL OR status=?)
  `).get(status, status)?.count || 0);
}

export function listInboxActionItems({ now = new Date(), limit = 3 } = {}) {
  const current = now.getTime();
  const day = 24 * 60 * 60_000;
  return listInboxItems({ limit: 100 }).filter((item) => {
    if (!item.event_at) return true;
    return Date.parse(item.event_at) >= current;
  }).sort((left, right) => {
    const rank = (item) => {
      if (!item.event_at) return item.kind === "task" ? 1 : 3;
      const delta = Date.parse(item.event_at) - current;
      if (delta < 0) return 0;
      if (delta <= 7 * day) return 0;
      return 2;
    };
    const difference = rank(left) - rank(right);
    if (difference) return difference;
    if (left.event_at && right.event_at) return left.event_at.localeCompare(right.event_at);
    return right.updated_at.localeCompare(left.updated_at);
  }).slice(0, Math.max(1, Math.min(20, Number(limit) || 3)));
}

export function updateInboxItem(id, changes, { reason = "natural correction", sourceMessageId = null } = {}) {
  const current = getInboxItem(id);
  if (!current) return null;
  const allowed = {};
  if (Object.hasOwn(changes, "kind")) allowed.kind = changes.kind;
  if (Object.hasOwn(changes, "title")) allowed.title = clean(changes.title, 300);
  if (Object.hasOwn(changes, "sourceUrl")) allowed.source_url = clean(changes.sourceUrl, 2000);
  if (Object.hasOwn(changes, "eventAt")) allowed.event_at = changes.eventAt;
  if (Object.hasOwn(changes, "nextAction")) allowed.next_action = clean(changes.nextAction, 500);
  if (Object.hasOwn(changes, "status")) allowed.status = changes.status;
  if (Object.hasOwn(changes, "assumptions")) allowed.assumptions_json = json(changes.assumptions.slice(0, 6));
  const entries = Object.entries(allowed);
  if (!entries.length) return current;
  const timestamp = now();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      INSERT INTO inbox_revisions(item_id, snapshot_json, reason, source_message_id, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(current.id, JSON.stringify(current), clean(reason, 500), sourceMessageId, timestamp);
    const assignments = entries.map(([column]) => `${column}=?`).join(", ");
    db.prepare(`
      UPDATE inbox_items SET ${assignments}, version=version+1, updated_at=? WHERE id=?
    `).run(...entries.map(([, value]) => value), timestamp, current.id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return getInboxItem(current.id);
}

export function inboxRevisionForSource(itemId, sourceMessageId) {
  if (sourceMessageId == null) return null;
  return db.prepare(`
    SELECT * FROM inbox_revisions WHERE item_id=? AND source_message_id=? ORDER BY id DESC LIMIT 1
  `).get(Number(itemId), Number(sourceMessageId)) || null;
}

export function recordInboxClassifierUsage({ classifier, input = "", output = "", at = new Date() }) {
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(at);
  const timestamp = now();
  db.prepare(`
    INSERT INTO inbox_classifier_usage(
      usage_date, rule_calls, ai_calls, input_chars, output_chars, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(usage_date) DO UPDATE SET
      rule_calls=rule_calls+excluded.rule_calls,
      ai_calls=ai_calls+excluded.ai_calls,
      input_chars=input_chars+excluded.input_chars,
      output_chars=output_chars+excluded.output_chars,
      updated_at=excluded.updated_at
  `).run(
    date, classifier === "rules" ? 1 : 0, classifier === "ai" ? 1 : 0,
    String(input).length, String(output).length, timestamp,
  );
}

export function inboxClassifierUsage(date = null) {
  const usageDate = date || new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  return db.prepare("SELECT * FROM inbox_classifier_usage WHERE usage_date=?").get(usageDate) || {
    usage_date: usageDate, rule_calls: 0, ai_calls: 0, input_chars: 0, output_chars: 0,
  };
}
