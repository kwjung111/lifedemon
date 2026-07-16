import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "lifedemon-profile-"));
const profileFile = join(dataDir, "profile.json");
process.env.HOUSING_DATA_DIR = dataDir;
process.env.HOUSING_USER_PROFILE_FILE = profileFile;
writeFileSync(profileFile, JSON.stringify({ birthDate: "1990-01-02", annualIncome: 37_000_000 }));
const legacyDb = new DatabaseSync(join(dataDir, "housing.sqlite"));
legacyDb.exec(`
  CREATE TABLE notice_reviews (
    notice_id TEXT PRIMARY KEY,
    content_hash TEXT NOT NULL,
    eligibility TEXT NOT NULL,
    score INTEGER NOT NULL,
    status TEXT NOT NULL,
    result_json TEXT NOT NULL,
    model TEXT,
    reviewed_at TEXT NOT NULL
  )
`);
legacyDb.close();

const {
  db, activeNotices, markReviewing, pendingReviewNotices, queueActiveForReview, saveNoticeReview,
  syncHousingReviewPolicy, upsertNotice,
} = await import("../src/db.mjs");
const {
  containsHousingProfileValues, housingProfileFingerprint, redactHousingProfileValues,
  requireHousingProfile, validateHousingProfile,
} = await import("../src/apps/housing/profile.mjs");

test.after(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function fixture() {
  return {
    id: "profile-a", source: "fixture", title: "notice", url: "https://example.test/a",
    verdict: "possible", categories: [], reasons: [], rawText: "fixture",
  };
}

test("fingerprint is stable across object key order and validates profile shape", () => {
  assert.equal(
    housingProfileFingerprint({ b: { d: 2, c: 1 }, a: true }),
    housingProfileFingerprint({ a: true, b: { c: 1, d: 2 } }),
  );
  assert.throws(() => validateHousingProfile([]), /JSON object/);
  assert.throws(() => validateHousingProfile({ amount: Number.NaN }), /finite/);
});

test("migrates legacy review scores to nullable without losing the table", () => {
  const scoreColumn = db.prepare("PRAGMA table_info(notice_reviews)").all().find((column) => column.name === "score");
  assert.equal(scoreColumn.notnull, 0);
  assert.ok(db.prepare("PRAGMA table_info(notice_reviews)").all().some((column) => column.name === "profile_fingerprint"));
  assert.ok(db.prepare("PRAGMA table_info(notice_reviews)").all().some((column) => column.name === "policy_version"));
});

test("redacts exact private profile values from nested AI output", () => {
  const profile = { birthDate: "1990-01-02", annualIncome: 37_000_000 };
  const result = { summary: "생년월일 1990-01-02, 소득 37,000,000원", evidence: ["공고 사실"] };
  assert.equal(containsHousingProfileValues(result, profile), true);
  assert.deepEqual(redactHousingProfileValues(result, profile), {
    summary: "생년월일 [개인정보], 소득 [개인정보]원", evidence: ["공고 사실"],
  });
});

test("redacts Korean date and amount variants instead of only exact JSON values", () => {
  const profile = {
    birthDate: "1990-01-02",
    annualIncome: 37_000_000,
    stocks: 51_000_000,
  };
  const result = {
    summary: "1990년 1월 2일생, 연봉 3,700만원, 주식 5,100만원인 신청자",
  };
  assert.deepEqual(redactHousingProfileValues(result, profile), {
    summary: "[개인정보]생, 연봉 [개인정보], 주식 [개인정보]인 신청자",
  });
});

test("removes transformed private facts that cannot be covered by exact variants", () => {
  const profile = { birthDate: "1990-01-02", annualIncome: 37_000_000, stocks: 51_000_000 };
  const result = {
    summary: "신청자는 만 36세이고 연봉 삼천칠백만원이다",
    cautions: ["본인 주식은 오천백만원"],
    evidence: ["사용자 프로필상 자격 충족"],
    costs: "공식 임대보증금 48,000,000원",
  };
  assert.deepEqual(redactHousingProfileValues(result, profile), {
    summary: "[개인정보 관련 판정은 원문 값을 숨김]",
    cautions: ["[개인정보 관련 판정은 원문 값을 숨김]"],
    evidence: ["[개인정보 관련 판정 제외]"],
    costs: "공식 임대보증금 48,000,000원",
  });
});

test("redacts derived age, partial birthday, and word-form income in visible fields", () => {
  const result = {
    summary: "만 36세로 청년 기준 충족",
    target_conditions: "1월 2일생으로 연령 기준 충족",
    income_assets: "삼천칠백만원으로 기준 확인 필요",
  };
  assert.deepEqual(redactHousingProfileValues(result, { birthDate: "1990-01-02", income: 37_000_000 }), {
    summary: "[개인정보 관련 판정은 원문 값을 숨김]",
    target_conditions: "[개인정보 관련 판정은 원문 값을 숨김]",
    income_assets: "[개인정보 관련 판정은 원문 값을 숨김]",
  });
});

test("redacts short private location values", () => {
  assert.deepEqual(
    redactHousingProfileValues({ summary: "직장은 테스트동이지만 변경 예정" }, { workplace: "테스트동" }),
    { summary: "직장은 [개인정보]이지만 변경 예정" },
  );
});

test("redacts transformed private facts in nested scoring reasons and follow-up purposes", () => {
  const result = {
    value_breakdown: { housing_value: { reasons: ["신청자는 만 36세이고 연봉 삼천칠백만원, 테스트동 근무"] } },
    needs: [{ purpose: "만 36세 신청자 확인" }],
  };
  assert.deepEqual(redactHousingProfileValues(result, {
    birthDate: "1990-01-02", annualIncome: 37_000_000, workplace: "테스트동",
  }), {
    value_breakdown: { housing_value: { reasons: ["[개인정보 관련 판정은 원문 값을 숨김]"] } },
    needs: [{ purpose: "[개인정보 관련 판정은 원문 값을 숨김]" }],
  });
});

test("profile change requeues active candidates and invalidates old review join", () => {
  upsertNotice(fixture());
  const notice = pendingReviewNotices()[0];
  assert.equal(markReviewing(notice), true);
  saveNoticeReview(notice, {
    eligibility: "uncertain", score: 50, status: "open",
    summary: "1990-01-02 신청자", cautions: [], evidence: [], needs: [],
  });
  assert.equal(JSON.parse(db.prepare("SELECT result_json FROM notice_reviews").get().result_json).summary, "[개인정보] 신청자");
  assert.equal(activeNotices()[0].ai_score, null);

  writeFileSync(profileFile, JSON.stringify({ birthDate: "1990-01-02", annualIncome: 38_000_000 }));
  const requeued = pendingReviewNotices();
  assert.equal(requeued.length, 1);
  assert.equal(requeued[0].review_reason, "profile_changed");
  assert.equal(activeNotices()[0].ai_score, null);
});

test("temporarily missing profile environment does not invalidate configured reviews", () => {
  const stored = db.prepare("SELECT value FROM settings WHERE key='housing_profile_fingerprint'").get().value;
  delete process.env.HOUSING_USER_PROFILE_FILE;
  activeNotices();
  assert.equal(db.prepare("SELECT value FROM settings WHERE key='housing_profile_fingerprint'").get().value, stored);
  process.env.HOUSING_USER_PROFILE_FILE = profileFile;
});

test("AI review profile loading fails closed when the private env is missing", () => {
  delete process.env.HOUSING_USER_PROFILE_FILE;
  assert.throws(() => requireHousingProfile(), /required/);
  process.env.HOUSING_USER_PROFILE_FILE = profileFile;
});

test("does not save a review produced for an older profile fingerprint", () => {
  const staleNotice = {
    ...fixture(),
    id: "profile-stale",
    url: "https://example.test/stale",
  };
  upsertNotice(staleNotice);
  const queued = pendingReviewNotices().find((notice) => notice.id === staleNotice.id);
  assert.ok(queued?.review_profile_fingerprint);

  writeFileSync(profileFile, JSON.stringify({ birthDate: "1990-01-02", annualIncome: 39_000_000 }));
  activeNotices();
  assert.equal(saveNoticeReview(queued, {
    eligibility: "yes", score: 90, status: "open", summary: "stale",
  }), false);
  assert.equal(db.prepare("SELECT count(*) AS count FROM notice_reviews WHERE notice_id=?").get(staleNotice.id).count, 0);
  assert.equal(db.prepare("SELECT state FROM review_queue WHERE notice_id=?").get(staleNotice.id).state, "pending");
});

test("does not let an old content review complete a newly changed queue item", () => {
  const original = { ...fixture(), id: "content-race", url: "https://example.test/race" };
  upsertNotice(original);
  const claimed = pendingReviewNotices().find((notice) => notice.id === original.id);
  assert.equal(markReviewing(claimed), true);
  assert.equal(markReviewing(claimed), false);
  upsertNotice({ ...original, rawText: "changed official content" });

  assert.equal(saveNoticeReview(claimed, { eligibility: "yes", score: 80, status: "open" }), false);
  assert.equal(db.prepare("SELECT count(*) AS count FROM notice_reviews WHERE notice_id=?").get(original.id).count, 0);
  assert.equal(db.prepare("SELECT state FROM review_queue WHERE notice_id=?").get(original.id).state, "pending");
});

test("uses a claim token so a manual requeue cannot be completed by the old worker", () => {
  const fixtureNotice = { ...fixture(), id: "claim-race", url: "https://example.test/claim" };
  upsertNotice(fixtureNotice);
  const workerA = pendingReviewNotices(100).find((notice) => notice.id === fixtureNotice.id);
  assert.equal(markReviewing(workerA), true);
  queueActiveForReview();
  const workerB = pendingReviewNotices(100).find((notice) => notice.id === fixtureNotice.id);
  assert.equal(markReviewing(workerB), true);
  assert.notEqual(workerA.review_claim_token, workerB.review_claim_token);

  assert.equal(saveNoticeReview(workerA, { eligibility: "yes", score: 90, status: "open" }), false);
  const queue = db.prepare("SELECT state, claim_token FROM review_queue WHERE notice_id=?").get(fixtureNotice.id);
  assert.equal(queue.state, "reviewing");
  assert.equal(queue.claim_token, workerB.review_claim_token);
});

test("review policy upgrades automatically requeue active candidates", () => {
  const fixtureNotice = { ...fixture(), id: "policy-upgrade", url: "https://example.test/policy" };
  upsertNotice(fixtureNotice);
  const stored = db.prepare("SELECT content_hash FROM notices WHERE id=?").get(fixtureNotice.id);
  const fingerprint = db.prepare("SELECT value FROM settings WHERE key='housing_profile_fingerprint'").get().value;
  db.prepare(`
    INSERT OR REPLACE INTO notice_reviews(
      notice_id, content_hash, eligibility, score, status, result_json,
      reviewed_at, profile_fingerprint, policy_version
    ) VALUES (?, ?, 'yes', 95, 'open', '{"eligibility":"yes","score":95}', ?, ?, 'old')
  `).run(fixtureNotice.id, stored.content_hash, new Date().toISOString(), fingerprint);
  db.prepare("UPDATE settings SET value='old' WHERE key='housing_review_policy_version'").run();

  assert.ok(syncHousingReviewPolicy() > 0);
  const queue = db.prepare("SELECT state, reason FROM review_queue WHERE notice_id=?").get(fixtureNotice.id);
  assert.equal(queue.state, "pending");
  assert.equal(queue.reason, "policy_changed");
  const visible = activeNotices().find((notice) => notice.id === fixtureNotice.id);
  assert.equal(visible.ai_result_json, null);
});

test("expired reviewing leases return to the retry queue", () => {
  const fixtureNotice = { ...fixture(), id: "expired-lease", url: "https://example.test/lease" };
  upsertNotice(fixtureNotice);
  const claimed = pendingReviewNotices(100).find((notice) => notice.id === fixtureNotice.id);
  assert.equal(markReviewing(claimed), true);
  db.prepare("UPDATE review_queue SET updated_at='2000-01-01T00:00:00.000Z' WHERE notice_id=?").run(fixtureNotice.id);

  const recovered = pendingReviewNotices(100).find((notice) => notice.id === fixtureNotice.id);
  assert.ok(recovered);
  const queue = db.prepare("SELECT state, claim_token, last_error FROM review_queue WHERE notice_id=?").get(fixtureNotice.id);
  assert.equal(queue.state, "error");
  assert.equal(queue.claim_token, null);
  assert.match(queue.last_error, /lease expired/);
});
