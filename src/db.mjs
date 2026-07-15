import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const dataDir = process.env.HOUSING_DATA_DIR || "/data/crawler/data";
mkdirSync(dataDir, { recursive: true });

export const db = new DatabaseSync(`${dataDir}/housing.sqlite`);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS notices (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    published_at TEXT,
    apply_start TEXT,
    apply_end TEXT,
    announcement_date TEXT,
    location TEXT,
    verdict TEXT NOT NULL,
    categories_json TEXT NOT NULL,
    reasons_json TEXT NOT NULL,
    raw_text TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS applications (
    notice_id TEXT PRIMARY KEY REFERENCES notices(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    applied_at TEXT,
    announcement_date TEXT,
    note TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS telegram_messages (
    message_id INTEGER PRIMARY KEY,
    notice_id TEXT NOT NULL REFERENCES notices(id) ON DELETE CASCADE,
    sent_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS telegram_digest_items (
    message_id INTEGER NOT NULL,
    item_no INTEGER NOT NULL,
    notice_id TEXT NOT NULL REFERENCES notices(id) ON DELETE CASCADE,
    PRIMARY KEY(message_id, item_no)
  );

  CREATE TABLE IF NOT EXISTS housing_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    keyword TEXT NOT NULL,
    instruction TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// Repair rules saved by the former `/rule` parser, which also matched `/rules`.
db.prepare(`
  UPDATE housing_rules
  SET keyword=substr(keyword, 3), instruction=substr(instruction, 3)
  WHERE keyword LIKE 's %' AND instruction LIKE 's %'
`).run();

const now = () => new Date().toISOString();

export function noticeId(source, url, title) {
  return createHash("sha256").update(`${source}\n${url}\n${title}`).digest("hex").slice(0, 24);
}

export function beginCollection() {
  db.exec("UPDATE notices SET active = 0");
}

export function upsertNotice(notice) {
  const id = notice.id || noticeId(notice.source, notice.url, notice.title);
  const timestamp = now();
  db.prepare(`
    INSERT INTO notices (
      id, source, title, url, published_at, apply_start, apply_end,
      announcement_date, location, verdict, categories_json, reasons_json,
      raw_text, active, first_seen, last_seen
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title=excluded.title, url=excluded.url, published_at=excluded.published_at,
      apply_start=excluded.apply_start, apply_end=excluded.apply_end,
      announcement_date=COALESCE(excluded.announcement_date, notices.announcement_date),
      location=excluded.location, verdict=excluded.verdict,
      categories_json=excluded.categories_json, reasons_json=excluded.reasons_json,
      raw_text=excluded.raw_text, active=1, last_seen=excluded.last_seen
  `).run(
    id, notice.source, notice.title, notice.url, notice.publishedAt || null,
    notice.applyStart || null, notice.applyEnd || null, notice.announcementDate || null,
    notice.location || null, notice.verdict, JSON.stringify(notice.categories || []),
    JSON.stringify(notice.reasons || []), (notice.rawText || "").slice(0, 50000),
    timestamp, timestamp,
  );
  return id;
}

export function activeNotices() {
  return db.prepare(`
    SELECT n.*, a.status AS application_status, a.applied_at,
           COALESCE(a.announcement_date, n.announcement_date) AS effective_announcement_date,
           a.note AS application_note
    FROM notices n
    LEFT JOIN applications a ON a.notice_id = n.id
    WHERE n.active = 1 AND n.verdict != 'exclude'
    ORDER BY CASE n.verdict WHEN 'likely' THEN 0 WHEN 'possible' THEN 1 ELSE 2 END,
             n.source, COALESCE(n.apply_end, n.published_at, n.first_seen) DESC
  `).all();
}

export function appliedNotices() {
  return db.prepare(`
    SELECT n.*, a.status AS application_status, a.applied_at,
           COALESCE(a.announcement_date, n.announcement_date) AS effective_announcement_date,
           a.note AS application_note
    FROM applications a JOIN notices n ON n.id = a.notice_id
    WHERE a.status = 'applied'
    ORDER BY COALESCE(a.announcement_date, n.announcement_date, a.applied_at) ASC
  `).all();
}

export function getNotice(id) {
  return db.prepare("SELECT * FROM notices WHERE id = ?").get(id);
}

export function setApplication(noticeIdValue, status, fields = {}) {
  const timestamp = now();
  db.prepare(`
    INSERT INTO applications (notice_id, status, applied_at, announcement_date, note, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(notice_id) DO UPDATE SET
      status=excluded.status,
      applied_at=COALESCE(excluded.applied_at, applications.applied_at),
      announcement_date=COALESCE(excluded.announcement_date, applications.announcement_date),
      note=COALESCE(excluded.note, applications.note),
      updated_at=excluded.updated_at
  `).run(
    noticeIdValue,
    status,
    fields.appliedAt || (status === "applied" ? timestamp : null),
    fields.announcementDate || null,
    fields.note || null,
    timestamp,
  );
}

export function setAnnouncementDate(noticeIdValue, date) {
  setApplication(noticeIdValue, "applied", { announcementDate: date });
}

export function saveTelegramMessage(messageId, noticeIdValue) {
  db.prepare(`
    INSERT INTO telegram_messages(message_id, notice_id, sent_at) VALUES (?, ?, ?)
    ON CONFLICT(message_id) DO UPDATE SET notice_id=excluded.notice_id, sent_at=excluded.sent_at
  `).run(messageId, noticeIdValue, now());
}

export function noticeForMessage(messageId) {
  return db.prepare(`
    SELECT n.* FROM telegram_messages m JOIN notices n ON n.id=m.notice_id
    WHERE m.message_id=?
  `).get(messageId);
}

export function saveDigestItems(messageId, noticeIds) {
  const insert = db.prepare(`
    INSERT INTO telegram_digest_items(message_id, item_no, notice_id) VALUES (?, ?, ?)
    ON CONFLICT(message_id, item_no) DO UPDATE SET notice_id=excluded.notice_id
  `);
  noticeIds.forEach((noticeIdValue, index) => insert.run(messageId, index + 1, noticeIdValue));
}

export function noticeForDigestItem(messageId, itemNo) {
  return db.prepare(`
    SELECT n.* FROM telegram_digest_items d JOIN notices n ON n.id=d.notice_id
    WHERE d.message_id=? AND d.item_no=?
  `).get(messageId, itemNo);
}

export function getSetting(key, fallback = null) {
  return db.prepare("SELECT value FROM settings WHERE key=?").get(key)?.value ?? fallback;
}

export function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings(key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `).run(key, String(value));
}

export function addHousingRule({ kind, keyword, text }) {
  const existing = db.prepare(`
    SELECT * FROM housing_rules WHERE enabled=1 AND kind=? AND keyword=?
  `).get(kind, keyword);
  if (existing) return existing;
  const result = db.prepare(`
    INSERT INTO housing_rules(kind, keyword, instruction, created_at)
    VALUES (?, ?, ?, ?)
  `).run(kind, keyword, text, now());
  return db.prepare("SELECT * FROM housing_rules WHERE id=?").get(result.lastInsertRowid);
}

export function listHousingRules() {
  return db.prepare(`
    SELECT * FROM housing_rules WHERE enabled=1 ORDER BY id
  `).all();
}

export function disableHousingRule(id) {
  return db.prepare("UPDATE housing_rules SET enabled=0 WHERE id=? AND enabled=1").run(id).changes > 0;
}
