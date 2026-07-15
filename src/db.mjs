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

  CREATE TABLE IF NOT EXISTS notice_reviews (
    notice_id TEXT PRIMARY KEY REFERENCES notices(id) ON DELETE CASCADE,
    content_hash TEXT NOT NULL,
    eligibility TEXT NOT NULL,
    score INTEGER NOT NULL,
    status TEXT NOT NULL,
    result_json TEXT NOT NULL,
    model TEXT,
    reviewed_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS review_queue (
    notice_id TEXT PRIMARY KEY REFERENCES notices(id) ON DELETE CASCADE,
    state TEXT NOT NULL DEFAULT 'pending',
    reason TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

const noticeColumns = new Set(db.prepare("PRAGMA table_info(notices)").all().map((column) => column.name));
if (!noticeColumns.has("content_hash")) db.exec("ALTER TABLE notices ADD COLUMN content_hash TEXT");

// Repair rules saved by the former `/rule` parser, which also matched `/rules`.
db.prepare(`
  UPDATE housing_rules
  SET keyword=substr(keyword, 3), instruction=substr(instruction, 3)
  WHERE keyword LIKE 's %' AND instruction LIKE 's %'
`).run();
db.prepare(`
  DELETE FROM review_queue
  WHERE state!='done' AND notice_id IN (SELECT id FROM notices WHERE verdict='review')
`).run();

const now = () => new Date().toISOString();

function stableRawText(value) {
  return String(value || "")
    .replace(/^.*?바로가기 메뉴/, "바로가기 메뉴")
    .replace(/조회수\s*:?[\s\u00a0]*[\d,]+/g, "조회수")
    .replace(/(공고중|접수중|접수마감)\s+[\d,]+\s*$/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function contentHashFor(notice, rawText = notice.rawText || notice.raw_text || "") {
  return createHash("sha256").update(JSON.stringify({
    title: notice.title,
    url: notice.url,
    publishedAt: notice.publishedAt || notice.published_at || null,
    applyStart: notice.applyStart || notice.apply_start || null,
    applyEnd: notice.applyEnd || notice.apply_end || null,
    announcementDate: notice.announcementDate || notice.announcement_date || null,
    rawText: stableRawText(rawText),
  })).digest("hex").slice(0, 32);
}

const hashVersion = db.prepare("SELECT value FROM settings WHERE key='content_hash_version'").get()?.value;
if (hashVersion !== "2") {
  for (const notice of db.prepare("SELECT * FROM notices").all()) {
    const hash = contentHashFor(notice);
    db.prepare("UPDATE notices SET content_hash=? WHERE id=?").run(hash, notice.id);
    db.prepare("UPDATE notice_reviews SET content_hash=? WHERE notice_id=?").run(hash, notice.id);
  }
  db.prepare(`
    INSERT INTO settings(key, value) VALUES ('content_hash_version', '2')
    ON CONFLICT(key) DO UPDATE SET value='2'
  `).run();
}

export function noticeId(source, url, title) {
  return createHash("sha256").update(`${source}\n${url}\n${title}`).digest("hex").slice(0, 24);
}

export function beginCollection() {
  db.exec("UPDATE notices SET active = 0");
}

export function upsertNotice(notice) {
  const id = notice.id || noticeId(notice.source, notice.url, notice.title);
  const timestamp = now();
  const rawText = (notice.rawText || "").slice(0, 50000);
  const contentHash = contentHashFor(notice, rawText);
  const previous = db.prepare("SELECT content_hash FROM notices WHERE id=?").get(id);
  db.prepare(`
    INSERT INTO notices (
      id, source, title, url, published_at, apply_start, apply_end,
      announcement_date, location, verdict, categories_json, reasons_json,
      raw_text, content_hash, active, first_seen, last_seen
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title=excluded.title, url=excluded.url, published_at=excluded.published_at,
      apply_start=excluded.apply_start, apply_end=excluded.apply_end,
      announcement_date=COALESCE(excluded.announcement_date, notices.announcement_date),
      location=excluded.location, verdict=excluded.verdict,
      categories_json=excluded.categories_json, reasons_json=excluded.reasons_json,
      raw_text=excluded.raw_text, content_hash=excluded.content_hash,
      active=1, last_seen=excluded.last_seen
  `).run(
    id, notice.source, notice.title, notice.url, notice.publishedAt || null,
    notice.applyStart || null, notice.applyEnd || null, notice.announcementDate || null,
    notice.location || null, notice.verdict, JSON.stringify(notice.categories || []),
    JSON.stringify(notice.reasons || []), rawText, contentHash,
    timestamp, timestamp,
  );
  if (["likely", "possible"].includes(notice.verdict) && previous?.content_hash !== contentHash) {
    db.prepare(`
      INSERT INTO review_queue(notice_id, state, reason, attempts, created_at, updated_at)
      VALUES (?, 'pending', ?, 0, ?, ?)
      ON CONFLICT(notice_id) DO UPDATE SET
        state='pending', reason=excluded.reason, attempts=0,
        last_error=NULL, updated_at=excluded.updated_at
    `).run(id, previous ? "changed" : "new", timestamp, timestamp);
  }
  return id;
}

export function activeNotices() {
  return db.prepare(`
    SELECT n.*, a.status AS application_status, a.applied_at,
           COALESCE(a.announcement_date, n.announcement_date) AS effective_announcement_date,
           a.note AS application_note,
           r.eligibility AS ai_eligibility, r.score AS ai_score,
           r.status AS ai_status, r.result_json AS ai_result_json,
           r.reviewed_at AS ai_reviewed_at
    FROM notices n
    LEFT JOIN applications a ON a.notice_id = n.id
    LEFT JOIN notice_reviews r ON r.notice_id = n.id AND r.content_hash = n.content_hash
    WHERE n.active = 1 AND n.verdict != 'exclude'
    ORDER BY CASE r.eligibility WHEN 'yes' THEN 0 WHEN 'uncertain' THEN 1 WHEN 'no' THEN 3 ELSE 2 END,
             COALESCE(r.score, 0) DESC,
             CASE n.verdict WHEN 'likely' THEN 0 WHEN 'possible' THEN 1 ELSE 2 END,
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

export function queueActiveForReview() {
  const timestamp = now();
  return db.prepare(`
    INSERT INTO review_queue(notice_id, state, reason, attempts, created_at, updated_at)
    SELECT n.id, 'pending', 'initial', 0, ?, ?
    FROM notices n
    WHERE n.active=1 AND n.verdict IN ('likely', 'possible')
    ON CONFLICT(notice_id) DO UPDATE SET
      state='pending', reason='initial', attempts=0, last_error=NULL, updated_at=excluded.updated_at
  `).run(timestamp, timestamp).changes;
}

export function pendingReviewNotices(limit = 3) {
  return db.prepare(`
    SELECT n.*, q.reason AS review_reason, q.attempts AS review_attempts
    FROM review_queue q JOIN notices n ON n.id=q.notice_id
    WHERE q.state IN ('pending', 'error') AND q.attempts<3 AND n.active=1
    ORDER BY CASE q.reason WHEN 'changed' THEN 0 WHEN 'new' THEN 1 ELSE 2 END,
             q.updated_at ASC
    LIMIT ?
  `).all(limit);
}

export function markReviewing(noticeIdValue) {
  db.prepare(`
    UPDATE review_queue SET state='reviewing', attempts=attempts+1, updated_at=?
    WHERE notice_id=?
  `).run(now(), noticeIdValue);
}

export function saveNoticeReview(notice, result, model = "codex-chatgpt") {
  const timestamp = now();
  db.prepare(`
    INSERT INTO notice_reviews(
      notice_id, content_hash, eligibility, score, status,
      result_json, model, reviewed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(notice_id) DO UPDATE SET
      content_hash=excluded.content_hash, eligibility=excluded.eligibility,
      score=excluded.score, status=excluded.status,
      result_json=excluded.result_json, model=excluded.model,
      reviewed_at=excluded.reviewed_at
  `).run(
    notice.id, notice.content_hash, result.eligibility,
    Math.max(0, Math.min(100, Number(result.score) || 0)),
    result.status || "review", JSON.stringify(result), model, timestamp,
  );
  db.prepare(`
    UPDATE review_queue SET state='done', last_error=NULL, updated_at=? WHERE notice_id=?
  `).run(timestamp, notice.id);
}

export function failNoticeReview(noticeIdValue, error) {
  db.prepare(`
    UPDATE review_queue SET state='error', last_error=?, updated_at=? WHERE notice_id=?
  `).run(String(error).slice(0, 1000), now(), noticeIdValue);
}
