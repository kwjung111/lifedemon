import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { semanticPreferenceScore } from "../feedback/preferences.mjs";

const dataDir = process.env.JOB_DATA_DIR || "/data/crawler/data";
mkdirSync(dataDir, { recursive: true });
export const jobDb = new DatabaseSync(`${dataDir}/jobs.sqlite`);
jobDb.exec(`
  PRAGMA journal_mode=WAL;
  PRAGMA busy_timeout=10000;
  CREATE TABLE IF NOT EXISTS job_postings (
    id TEXT PRIMARY KEY, source TEXT NOT NULL, external_id TEXT, company TEXT NOT NULL,
    title TEXT NOT NULL, url TEXT NOT NULL, location TEXT, experience TEXT, raw_text TEXT NOT NULL,
    content_hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS job_postings_source_url ON job_postings(source, url);
  CREATE TABLE IF NOT EXISTS job_filter_queue (
    posting_id TEXT PRIMARY KEY REFERENCES job_postings(id) ON DELETE CASCADE,
    state TEXT NOT NULL DEFAULT 'pending', reason TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS job_assessments (
    posting_id TEXT PRIMARY KEY REFERENCES job_postings(id) ON DELETE CASCADE,
    content_hash TEXT NOT NULL, profile_fingerprint TEXT NOT NULL, decision TEXT NOT NULL,
    result_json TEXT NOT NULL, model TEXT, assessed_at TEXT NOT NULL, verification_fingerprint TEXT
  );
  CREATE TABLE IF NOT EXISTS job_applications (
    posting_id TEXT PRIMARY KEY REFERENCES job_postings(id) ON DELETE CASCADE,
    status TEXT NOT NULL, applied_at TEXT, note TEXT, updated_at TEXT NOT NULL,
    recommendation_hidden INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS job_digest_items (
    message_id INTEGER NOT NULL, item_index INTEGER NOT NULL,
    posting_id TEXT NOT NULL REFERENCES job_postings(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (message_id, item_index)
  );
  CREATE TABLE IF NOT EXISTS job_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);
const assessmentColumns = new Set(jobDb.prepare("PRAGMA table_info(job_assessments)").all().map((column) => column.name));
if (!assessmentColumns.has("verification_fingerprint")) jobDb.exec("ALTER TABLE job_assessments ADD COLUMN verification_fingerprint TEXT");
const applicationColumns = new Set(jobDb.prepare("PRAGMA table_info(job_applications)").all().map((column) => column.name));
if (!applicationColumns.has("recommendation_hidden")) {
  jobDb.exec("ALTER TABLE job_applications ADD COLUMN recommendation_hidden INTEGER NOT NULL DEFAULT 0");
  jobDb.exec("UPDATE job_applications SET recommendation_hidden=1 WHERE status='ignored'");
}

const now = () => new Date().toISOString();
const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
const hashFor = (job) => createHash("sha256").update(JSON.stringify({ company: clean(job.company), title: clean(job.title), url: job.url, raw: clean(job.rawText) })).digest("hex").slice(0, 32);
export const jobId = (source, url) => createHash("sha256").update(`${source}\n${url}`).digest("hex").slice(0, 24);

export function upsertJobPostingWithStatus(job) {
  if (!job?.source || !job?.company || !job?.title || !job?.url) throw new Error("job posting needs source, company, title, and url");
  const id = job.id || jobId(job.source, job.url);
  const timestamp = now();
  const rawText = clean(job.rawText).slice(0, 60_000);
  const contentHash = hashFor({ ...job, rawText });
  const previous = jobDb.prepare("SELECT content_hash FROM job_postings WHERE id=?").get(id);
  jobDb.prepare(`
    INSERT INTO job_postings(id, source, external_id, company, title, url, location, experience, raw_text, content_hash, active, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET external_id=excluded.external_id, company=excluded.company, title=excluded.title,
      url=excluded.url, location=excluded.location, experience=excluded.experience, raw_text=excluded.raw_text,
      content_hash=excluded.content_hash, active=1, last_seen=excluded.last_seen
  `).run(id, job.source, job.externalId || null, clean(job.company), clean(job.title), job.url, clean(job.location) || null,
    clean(job.experience) || null, rawText, contentHash, timestamp, timestamp);
  if (!previous || previous.content_hash !== contentHash) {
    jobDb.prepare(`
      INSERT INTO job_filter_queue(posting_id, state, reason, attempts, created_at, updated_at)
      VALUES (?, 'pending', ?, 0, ?, ?)
      ON CONFLICT(posting_id) DO UPDATE SET state='pending', reason=excluded.reason, attempts=0, last_error=NULL, updated_at=excluded.updated_at
    `).run(id, previous ? "changed" : "new", timestamp, timestamp);
  }
  return {
    id,
    change: !previous ? "new" : previous.content_hash !== contentHash ? "changed" : "unchanged",
  };
}

export function upsertJobPosting(job) {
  return upsertJobPostingWithStatus(job).id;
}

export function markJobSourceComplete(source, activeIds) {
  const ids = [...new Set(activeIds)];
  if (!ids.length) return 0; // A zero-result scrape is not proof that every posting closed.
  return jobDb.prepare(`UPDATE job_postings SET active=0 WHERE source=? AND id NOT IN (${ids.map(() => "?").join(",")})`).run(source, ...ids).changes;
}

export function getJobSetting(key, fallback = null) {
  return jobDb.prepare("SELECT value FROM job_settings WHERE key=?").get(key)?.value ?? fallback;
}

export function setJobSetting(key, value) {
  jobDb.prepare("INSERT INTO job_settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, String(value));
}

export function pendingJobFilters(limit = 100) {
  return jobDb.prepare(`
    SELECT p.*, q.reason AS queue_reason FROM job_filter_queue q JOIN job_postings p ON p.id=q.posting_id
    WHERE p.active=1 AND q.state IN ('pending','error') AND q.attempts<3 ORDER BY q.updated_at ASC LIMIT ?
  `).all(limit);
}

export function syncJobFilterInputs(profileFingerprint, verificationFingerprint) {
  const current = `${profileFingerprint}:${verificationFingerprint}`;
  const previous = jobDb.prepare("SELECT value FROM job_settings WHERE key='job_filter_inputs_fingerprint'").get()?.value;
  if (previous === current) return 0;
  const timestamp = now();
  const changes = jobDb.prepare(`
    INSERT INTO job_filter_queue(posting_id, state, reason, attempts, created_at, updated_at)
    SELECT id, 'pending', 'filter_inputs_changed', 0, ?, ? FROM job_postings WHERE active=1
    ON CONFLICT(posting_id) DO UPDATE SET state='pending', reason='filter_inputs_changed', attempts=0, last_error=NULL, updated_at=excluded.updated_at
  `).run(timestamp, timestamp).changes;
  jobDb.prepare("INSERT INTO job_settings(key, value) VALUES ('job_filter_inputs_fingerprint', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(current);
  return changes;
}

export function markJobFiltering(id) {
  return jobDb.prepare("UPDATE job_filter_queue SET state='reviewing', attempts=attempts+1, updated_at=? WHERE posting_id=? AND state IN ('pending','error')").run(now(), id).changes > 0;
}

export function saveJobAssessment(job, result, profileFingerprint, verificationFingerprint, model = "codex-chatgpt") {
  const timestamp = now();
  jobDb.exec("BEGIN IMMEDIATE");
  try {
    const current = jobDb.prepare("SELECT content_hash FROM job_postings WHERE id=?").get(job.id);
    if (!current || current.content_hash !== job.content_hash) { jobDb.exec("ROLLBACK"); return false; }
    jobDb.prepare(`
      INSERT INTO job_assessments(posting_id, content_hash, profile_fingerprint, decision, result_json, model, assessed_at, verification_fingerprint)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(posting_id) DO UPDATE SET content_hash=excluded.content_hash, profile_fingerprint=excluded.profile_fingerprint,
        decision=excluded.decision, result_json=excluded.result_json, model=excluded.model, assessed_at=excluded.assessed_at,
        verification_fingerprint=excluded.verification_fingerprint
    `).run(job.id, job.content_hash, profileFingerprint, result.decision, JSON.stringify(result), model, timestamp, verificationFingerprint);
    jobDb.prepare("UPDATE job_filter_queue SET state='done', last_error=NULL, updated_at=? WHERE posting_id=? AND state='reviewing'").run(timestamp, job.id);
    jobDb.exec("COMMIT");
    return true;
  } catch (error) { jobDb.exec("ROLLBACK"); throw error; }
}

export function failJobFilter(id, error) {
  return jobDb.prepare("UPDATE job_filter_queue SET state='error', last_error=?, updated_at=? WHERE posting_id=? AND state='reviewing'").run(String(error).slice(0, 1000), now(), id).changes > 0;
}

const canonicalCompany = (value) => clean(value).toLowerCase()
  .replace(/주식회사|\(주\)|㈜/g, "")
  .replace(/[^0-9a-z가-힣]/g, "");
const canonicalTitle = (value) => clean(value).toLowerCase().replace(/[^0-9a-z가-힣]/g, "");
export const canonicalJobKey = (job) => `${canonicalCompany(job.company)}|${canonicalTitle(job.title)}`;

const sourcePriority = { wanted: 0, remember: 1, jobkorea: 2 };
function preferredDuplicate(left, right) {
  if (left.decision !== right.decision) return left.decision === "pass" ? left : right;
  return (sourcePriority[left.source] ?? 9) <= (sourcePriority[right.source] ?? 9) ? left : right;
}

export function jobAssessmentSummary(profileFingerprint, verificationFingerprint, limit = 12, {
  excludedCompanies = [],
  preferredCompanies = [],
  semanticPreferences = [],
} = {}) {
  const excludedCompanyKeys = new Set(excludedCompanies.map(canonicalCompany).filter(Boolean));
  const preferredCompanyKeys = new Set(preferredCompanies.map(canonicalCompany).filter(Boolean));
  const rows = jobDb.prepare(`
    SELECT p.*, a.decision, a.result_json, a.assessed_at, ja.status AS application_status,
           COALESCE(ja.recommendation_hidden, 0) AS recommendation_hidden
      FROM job_assessments a JOIN job_postings p ON p.id=a.posting_id
      LEFT JOIN job_applications ja ON ja.posting_id=p.id
     WHERE p.active=1 AND a.profile_fingerprint=? AND a.verification_fingerprint=?
  `).all(profileFingerprint, verificationFingerprint);
  const groups = new Map();
  for (const row of rows) {
    const key = canonicalJobKey(row);
    const group = groups.get(key) || { hidden: false, row: null };
    group.hidden ||= row.application_status === "applied" || Boolean(row.recommendation_hidden);
    group.hidden ||= excludedCompanyKeys.has(canonicalCompany(row.company));
    group.row = group.row ? preferredDuplicate(group.row, row) : row;
    groups.set(key, group);
  }
  const uniqueRows = [...groups.values()].filter((group) => !group.hidden).map((group) => group.row);
  const counts = {};
  for (const row of uniqueRows) counts[row.decision] = (counts[row.decision] || 0) + 1;
  const selected = uniqueRows
    .filter((row) => ["pass", "uncertain"].includes(row.decision))
    .sort((left, right) => {
      if (left.decision !== right.decision) return left.decision === "pass" ? -1 : 1;
      const preferenceDifference = Number(preferredCompanyKeys.has(canonicalCompany(right.company)))
        - Number(preferredCompanyKeys.has(canonicalCompany(left.company)));
      const semanticDifference = semanticPreferenceScore(right, semanticPreferences, "jobs")
        - semanticPreferenceScore(left, semanticPreferences, "jobs");
      return semanticDifference || preferenceDifference || String(right.assessed_at).localeCompare(String(left.assessed_at));
    })
    .slice(0, limit);
  const failures = jobDb.prepare(`
    SELECT q.last_error FROM job_filter_queue q JOIN job_postings p ON p.id=q.posting_id
     WHERE p.active=1 AND q.state='error' ORDER BY q.updated_at DESC LIMIT 3
  `).all().map((row) => row.last_error);
  return { counts, selected, failures };
}

export function getJobPosting(id) {
  return jobDb.prepare("SELECT * FROM job_postings WHERE id=?").get(id) || null;
}

export function setJobApplication(postingId, status = "applied", fields = {}) {
  const timestamp = now();
  jobDb.prepare(`
    INSERT INTO job_applications(posting_id, status, applied_at, note, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(posting_id) DO UPDATE SET
      status=excluded.status,
      applied_at=COALESCE(excluded.applied_at, job_applications.applied_at),
      note=COALESCE(excluded.note, job_applications.note),
      updated_at=excluded.updated_at
  `).run(postingId, status, fields.appliedAt || (status === "applied" ? timestamp : null), fields.note || null, timestamp);
  return getJobPosting(postingId);
}

export function jobApplicationStatus(postingId) {
  const status = jobDb.prepare("SELECT status FROM job_applications WHERE posting_id=?").get(postingId)?.status;
  return !status || status === "none" ? null : status;
}

export function jobRecommendationHidden(postingId) {
  return Boolean(jobDb.prepare("SELECT recommendation_hidden FROM job_applications WHERE posting_id=?").get(postingId)?.recommendation_hidden);
}

export function setJobRecommendationHidden(postingId, hidden = true) {
  const timestamp = now();
  const existing = jobDb.prepare("SELECT status FROM job_applications WHERE posting_id=?").get(postingId);
  if (existing) {
    jobDb.prepare("UPDATE job_applications SET recommendation_hidden=?, updated_at=? WHERE posting_id=?")
      .run(hidden ? 1 : 0, timestamp, postingId);
  } else {
    jobDb.prepare(`
      INSERT INTO job_applications(posting_id, status, applied_at, note, updated_at, recommendation_hidden)
      VALUES (?, 'none', NULL, NULL, ?, ?)
    `).run(postingId, timestamp, hidden ? 1 : 0);
  }
  return hidden;
}

export function restoreJobRecommendationHidden(postingId, hidden = false) {
  return setJobRecommendationHidden(postingId, hidden);
}

export function restoreJobApplicationStatus(postingId, status = null) {
  if (!status) return jobDb.prepare("DELETE FROM job_applications WHERE posting_id=?").run(postingId).changes > 0;
  setJobApplication(postingId, status);
  return true;
}

export function appliedJobs() {
  const rows = jobDb.prepare(`
    SELECT p.*, ja.applied_at, ja.note, ja.updated_at AS application_updated_at
      FROM job_applications ja JOIN job_postings p ON p.id=ja.posting_id
     WHERE ja.status='applied'
     ORDER BY COALESCE(ja.applied_at, ja.updated_at) DESC
  `).all();
  const unique = new Map();
  for (const row of rows) {
    const key = canonicalJobKey(row);
    const previous = unique.get(key);
    unique.set(key, previous ? preferredDuplicate(previous, row) : row);
  }
  return [...unique.values()];
}

export function saveJobDigestItems(messageId, items) {
  const insert = jobDb.prepare(`
    INSERT INTO job_digest_items(message_id, item_index, posting_id, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(message_id, item_index) DO UPDATE SET posting_id=excluded.posting_id, created_at=excluded.created_at
  `);
  const timestamp = now();
  for (const item of items) insert.run(messageId, item.index, item.id, timestamp);
}

export function jobForDigestItem(messageId, itemIndex) {
  return jobDb.prepare(`
    SELECT p.* FROM job_digest_items d JOIN job_postings p ON p.id=d.posting_id
     WHERE d.message_id=? AND d.item_index=?
  `).get(messageId, itemIndex) || null;
}

export function jobsForDigest(messageId) {
  return jobDb.prepare(`
    SELECT p.*, d.item_index AS item_index
    FROM job_digest_items d JOIN job_postings p ON p.id=d.posting_id
    WHERE d.message_id=? ORDER BY d.item_index
  `).all(messageId);
}

export function activeJobCompanies(limit = 100) {
  return jobDb.prepare("SELECT company, MAX(last_seen) AS last_seen FROM job_postings WHERE active=1 GROUP BY company ORDER BY last_seen DESC LIMIT ?").all(limit).map((row) => row.company);
}
