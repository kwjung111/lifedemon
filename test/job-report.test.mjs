import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "lifedemon-job-report-"));
const profileFile = join(dataDir, "profile.json");
const companyFile = join(dataDir, "companies.json");
process.env.JOB_DATA_DIR = dataDir;
process.env.JOB_USER_PROFILE_FILE = profileFile;
process.env.JOB_COMPANY_VERIFICATION_FILE = companyFile;
process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.TELEGRAM_CHAT_ID = "1";
writeFileSync(profileFile, JSON.stringify({ preferences: { preferredRoles: ["devops"], excludedRoles: ["backend"] }, companyFilters: { jobplanet: { minimumRating: 2.5, excludeWhenMissing: true }, minimumEmployeeCount: 11 } }));
writeFileSync(companyFile, JSON.stringify([]));

const { appliedJobs, jobDb, saveJobAssessment, setJobApplication, upsertJobPosting } = await import("../src/apps/jobs/db.mjs");
const { formatJobApplicationStatus, formatJobReport, formatJobReportPages } = await import("../src/apps/jobs/report.mjs");
const { companyVerificationFingerprint, loadAuthorizedCompanyVerifications } = await import("../src/apps/jobs/company-verification.mjs");
const { jobProfileFingerprint, loadJobProfile } = await import("../src/apps/jobs/profile.mjs");

test.after(() => { jobDb.close(); rmSync(dataDir, { recursive: true, force: true }); });

test("reports strict verification status without exposing private profile", () => {
  const report = formatJobReport([{ source: "remember", count: 38 }, { source: "wanted", error: "session needed" }]);
  assert.match(report, /리멤버 38/);
  assert.match(report, /원티드 오류/);
  assert.match(report, /회사 검증 데이터가 아직 없어/);
  assert.doesNotMatch(report, /backend|devops/i);
});

test("excludes jobs recorded as applied from later reports", () => {
  const id = upsertJobPosting({
    source: "wanted", company: "테스트회사", title: "DevOps Engineer",
    url: "https://www.wanted.co.kr/wd/123", rawText: "AWS Kubernetes CI/CD",
  });
  const job = jobDb.prepare("SELECT * FROM job_postings WHERE id=?").get(id);
  saveJobAssessment(
    job,
    { decision: "pass", summary: "적합", reasons: [], concerns: [], evidence: [] },
    jobProfileFingerprint(loadJobProfile()),
    companyVerificationFingerprint(loadAuthorizedCompanyVerifications()),
  );
  assert.match(formatJobReport(), /테스트회사/);
  setJobApplication(id, "applied");
  assert.doesNotMatch(formatJobReport(), /테스트회사/);
});

test("keeps a job digest in one Telegram message", () => {
  assert.equal(formatJobReportPages([], { limit: 100 }).length, 1);
  assert.ok(formatJobReportPages([], { limit: 100 })[0].length <= 4000);
});

test("deduplicates the same company and posting across sources", () => {
  const profileFingerprint = jobProfileFingerprint(loadJobProfile());
  const verificationFingerprint = companyVerificationFingerprint(loadAuthorizedCompanyVerifications());
  const ids = [
    upsertJobPosting({ source: "remember", company: "(주)중복회사", title: "DevOps Engineer", url: "https://career.rememberapp.co.kr/job/posting/777", rawText: "AWS" }),
    upsertJobPosting({ source: "jobkorea", company: "㈜중복회사", title: "DevOps Engineer", url: "https://www.jobkorea.co.kr/Recruit/GI_Read/888", rawText: "AWS" }),
  ];
  for (const id of ids) {
    const job = jobDb.prepare("SELECT * FROM job_postings WHERE id=?").get(id);
    saveJobAssessment(job, { decision: "pass", summary: "적합", reasons: [], concerns: [], evidence: [] }, profileFingerprint, verificationFingerprint);
  }
  assert.equal((formatJobReport().match(/중복회사/g) || []).length, 1);
  setJobApplication(ids[1], "applied");
  assert.doesNotMatch(formatJobReport(), /중복회사/);
});

test("tracks applied jobs separately from ignored jobs", () => {
  const appliedId = upsertJobPosting({ source: "wanted", company: "지원회사", title: "SRE", url: "https://www.wanted.co.kr/wd/901", rawText: "SRE" });
  const ignoredId = upsertJobPosting({ source: "wanted", company: "관심없는회사", title: "DevOps", url: "https://www.wanted.co.kr/wd/902", rawText: "DevOps" });
  setJobApplication(appliedId, "applied");
  setJobApplication(ignoredId, "ignored");
  assert.equal(appliedJobs().some((job) => job.id === appliedId), true);
  assert.equal(appliedJobs().some((job) => job.id === ignoredId), false);
  assert.match(formatJobApplicationStatus(), /지원회사/);
  assert.doesNotMatch(formatJobApplicationStatus(), /관심없는회사/);
});
