import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "lifedemon-visibility-"));
const housingProfile = join(dataDir, "housing-profile.json");
const jobProfile = join(dataDir, "job-profile.json");
const companies = join(dataDir, "companies.json");
writeFileSync(housingProfile, JSON.stringify({ birthDate: "1990-01-01", householdSize: 1 }));
writeFileSync(jobProfile, JSON.stringify({
  preferences: { preferredRoles: ["DevOps"], excludedRoles: [] },
  companyFilters: { jobplanet: { minimumRating: 2.5, excludeWhenMissing: true }, minimumEmployeeCount: 10 },
}));
writeFileSync(companies, JSON.stringify([]));
process.env.MONITOR_DATA_DIR = dataDir;
process.env.HOUSING_DATA_DIR = dataDir;
process.env.JOB_DATA_DIR = dataDir;
process.env.HOUSING_USER_PROFILE_FILE = housingProfile;
process.env.JOB_USER_PROFILE_FILE = jobProfile;
process.env.JOB_COMPANY_VERIFICATION_FILE = companies;
process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.TELEGRAM_CHAT_ID = "1";

const { db: housingDb, setApplication, upsertNotice } = await import("../src/db.mjs");
const {
  jobDb, saveJobAssessment, setJobApplication, setJobRecommendationHidden, upsertJobPosting,
} = await import("../src/apps/jobs/db.mjs");
const { companyVerificationFingerprint, loadAuthorizedCompanyVerifications } = await import("../src/apps/jobs/company-verification.mjs");
const { jobProfileFingerprint, loadJobProfile } = await import("../src/apps/jobs/profile.mjs");
const { platformDb } = await import("../src/core/state.mjs");
const {
  explainRecommendationVisibility, sendRecommendationExplanation,
} = await import("../src/apps/briefing/visibility.mjs");

function addAssessedJob({ company, title, source = "wanted", suffix }) {
  const id = upsertJobPosting({
    source, company, title,
    url: source === "wanted" ? `https://www.wanted.co.kr/wd/${suffix}` : `https://example.test/${source}/${suffix}`,
    rawText: "AWS Kubernetes Terraform",
  });
  const job = jobDb.prepare("SELECT * FROM job_postings WHERE id=?").get(id);
  saveJobAssessment(
    job, { decision: "pass", summary: "적합", reasons: [], concerns: [], evidence: [] },
    jobProfileFingerprint(loadJobProfile()),
    companyVerificationFingerprint(loadAuthorizedCompanyVerifications()),
  );
  return id;
}

const appliedJobId = addAssessedJob({ company: "추적회사", title: "DevOps Engineer", suffix: "8101" });
setJobApplication(appliedJobId, "applied");
const ignoredJobId = addAssessedJob({ company: "숨김회사", title: "Platform Engineer", suffix: "8102" });
setJobRecommendationHidden(ignoredJobId, true);
addAssessedJob({ company: "노출회사", title: "SRE Engineer", suffix: "8103" });
addAssessedJob({ company: "공통회사", title: "Cloud Engineer", suffix: "8104" });
addAssessedJob({ company: "공통회사", title: "Infrastructure Engineer", suffix: "8105" });

upsertNotice({
  id: "expired-housing", source: "SH", title: "테스트 청년 매입임대",
  url: "https://www.i-sh.co.kr/test/expired", verdict: "likely",
  categories: ["청년"], reasons: ["서울"], rawText: "공식 공고", applyEnd: "2020-01-01",
});
upsertNotice({
  id: "result-housing", source: "LH", title: "결과가 난 청년임대",
  url: "https://apply.lh.or.kr/test/result", verdict: "likely",
  categories: ["청년"], reasons: ["서울"], rawText: "공식 공고", applyEnd: "2020-01-01",
});
setApplication("result-housing", "not_selected");

test.after(() => {
  housingDb.close();
  jobDb.close();
  platformDb.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test("explains applied and ignored jobs without guessing", () => {
  const applied = explainRecommendationVisibility({ domain: "jobs", query: "추적회사" });
  assert.equal(applied.code, "applied");
  assert.match(applied.reason, /지원 이력/);
  const ignored = explainRecommendationVisibility({ domain: "jobs", query: "숨김회사" });
  assert.equal(ignored.code, "ignored");
  assert.match(ignored.action, /관심없음 취소/);
});

test("distinguishes a visible later recommendation from an exclusion", () => {
  const visible = explainRecommendationVisibility({ domain: "jobs", query: "노출회사" });
  assert.equal(visible.code, "visible");
  assert.ok(visible.shownIndex >= 1);
});

test("asks once when a company maps to multiple distinct postings", () => {
  const ambiguous = explainRecommendationVisibility({ domain: "jobs", query: "공통회사" });
  assert.equal(ambiguous.status, "ambiguous");
  assert.equal(ambiguous.items.length, 2);
  assert.deepEqual(ambiguous.items.map((item) => item.index), [1, 2]);
});

test("explains housing expiration and a completed application result", () => {
  assert.equal(explainRecommendationVisibility({ domain: "housing", query: "테스트 청년 매입임대" }).code, "expired");
  assert.equal(explainRecommendationVisibility({ domain: "housing", query: "결과가 난 청년임대" }).code, "not_selected");
});

test("preserves a reply target on the explanation message", async () => {
  const calls = [];
  const explained = await sendRecommendationExplanation({ domain: "jobs", query: "추적회사" }, {
    send: async (text, _extra, delivery) => calls.push({ text, delivery }),
  });
  assert.equal(explained.item.id, appliedJobId);
  assert.match(calls[0].text, /추천 노출 상태/);
  assert.equal(calls[0].delivery.context.kind, "visibility");
  assert.equal(calls[0].delivery.context.items[0].id, appliedJobId);
});

test("returns not_found without inventing a reason", () => {
  const result = explainRecommendationVisibility({ query: "존재하지않는공고" });
  assert.equal(result.status, "not_found");
});
