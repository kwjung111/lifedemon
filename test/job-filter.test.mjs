import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "lifedemon-jobs-"));
const profileFile = join(dataDir, "profile.json");
const companyFile = join(dataDir, "companies.json");
process.env.JOB_DATA_DIR = dataDir;
process.env.JOB_USER_PROFILE_FILE = profileFile;
process.env.JOB_COMPANY_VERIFICATION_FILE = companyFile;
writeFileSync(profileFile, JSON.stringify({
  preferences: { preferredRoles: ["devops"], excludedRoles: ["backend"] },
  companyFilters: { jobplanet: { minimumRating: 2.5, excludeWhenMissing: true }, minimumEmployeeCount: 11 },
}));
writeFileSync(companyFile, JSON.stringify([{ company: "좋은회사", jobplanetRating: 3.8, employeeCount: 50, provenance: "authorized_import" }]));

const { companyGate, companyVerificationFingerprint, loadAuthorizedCompanyVerifications } = await import("../src/apps/jobs/company-verification.mjs");
const { jobDb, markJobFiltering, pendingJobFilters, queueStaleWantedAssessments, recoverStaleJobFilterClaims, upsertJobPosting, upsertJobPostingWithStatus } = await import("../src/apps/jobs/db.mjs");
const { drainJobFilters, filterJobs, normalizeJobAssessment } = await import("../src/apps/jobs/filter.mjs");
const { jobDiscoveryQueries, jobProfileFingerprint, loadJobProfile } = await import("../src/apps/jobs/profile.mjs");
const { summarizeJobsDailyRun } = await import("../src/apps/jobs/daily-state.mjs");

test.after(() => { jobDb.close(); rmSync(dataDir, { recursive: true, force: true }); });

test("strictly excludes companies with no authorized Jobplanet verification", () => {
  const gate = companyGate("없는회사", loadJobProfile(), loadAuthorizedCompanyVerifications());
  assert.equal(gate.decision, "exclude");
  assert.equal(gate.code, "company_verification_missing");
});

test("strictly excludes rating below threshold and companies of ten people or fewer", () => {
  const profile = loadJobProfile();
  const lowRating = new Map([["낮은회사", { jobplanetRating: 2.4, employeeCount: 100 }]]);
  const tiny = new Map([["작은회사", { jobplanetRating: 4.0, employeeCount: 10 }]]);
  assert.equal(companyGate("낮은회사", profile, lowRating).code, "jobplanet_rating_below_minimum");
  assert.equal(companyGate("작은회사", profile, tiny).code, "employee_count_below_minimum");
});

test("calls AI only after deterministic company verification passes", async () => {
  upsertJobPosting({ source: "fixture", company: "좋은회사", title: "DevOps Engineer", url: "https://example.test/devops", rawText: "Kubernetes and infrastructure" });
  upsertJobPosting({ source: "fixture", company: "검증없음", title: "DevOps Engineer", url: "https://example.test/missing", rawText: "Kubernetes" });
  const prompts = [];
  const output = await filterJobs({ assess: async (prompt) => {
    prompts.push(prompt);
    return { decision: "pass", summary: "적합", reasons: ["데브옵스"], concerns: [], evidence: ["Kubernetes"] };
  } });
  assert.equal(prompts.length, 1);
  assert.deepEqual(output.map((item) => item.decision), ["pass", "exclude"]);
  assert.equal(pendingJobFilters().length, 0);
});

test("does not accept arbitrary AI decisions", () => {
  assert.throws(() => normalizeJobAssessment({ decision: "recommend" }), /decision/);
});

test("rechecks active postings after authorized company verification data changes", async () => {
  writeFileSync(companyFile, JSON.stringify([
    { company: "좋은회사", jobplanetRating: 3.8, employeeCount: 50 },
    { company: "검증없음", jobplanetRating: 3.5, employeeCount: 20 },
  ]));
  const prompts = [];
  await filterJobs({ assess: async (prompt) => {
    prompts.push(prompt);
    return { decision: "pass", summary: "재평가", reasons: [], concerns: [], evidence: [] };
  } });
  assert.ok(prompts.length >= 2);
  assert.equal(pendingJobFilters().length, 0);
});

test("drains every active pending job across bounded batches", async () => {
  for (let index = 0; index < 5; index += 1) {
    upsertJobPosting({
      source: "fixture",
      company: `미검증회사${index}`,
      title: "DevOps Engineer",
      url: `https://example.test/drain-${index}`,
      rawText: "Kubernetes",
    });
  }
  const output = await drainJobFilters({ batchSize: 2, assess: async () => {
    throw new Error("미검증 회사는 AI 호출 전에 제외되어야 함");
  } });
  assert.equal(output.length, 5);
  assert.equal(pendingJobFilters().length, 0);
});

test("profile fingerprint changes when a nested filtering condition changes", () => {
  const profile = loadJobProfile();
  assert.notEqual(jobProfileFingerprint(profile), jobProfileFingerprint({
    ...profile, companyFilters: { ...profile.companyFilters, minimumEmployeeCount: 12 },
  }));
});

test("uses configured discovery queries without making them eligibility decisions", () => {
  const profile = { ...loadJobProfile(), preferences: { ...loadJobProfile().preferences, discoveryQueries: ["SRE", "DevOps"] } };
  assert.deepEqual(jobDiscoveryQueries(profile), ["SRE", "DevOps"]);
});

test("does not requeue every job when only company verification refresh time changes", () => {
  const first = new Map([["좋은회사", { company: "좋은회사", jobplanetRating: 3.8, employeeCount: 50, provenance: "authorized", verifiedAt: "2026-07-21" }]]);
  const refreshed = new Map([["좋은회사", { ...first.get("좋은회사"), verifiedAt: "2026-07-22" }]]);
  assert.equal(companyVerificationFingerprint(first), companyVerificationFingerprint(refreshed));
});

test("ignores volatile Remember chrome while detecting an actual deadline change", () => {
  const base = {
    source: "remember", company: "좋은회사", title: "SRE", url: "https://career.rememberapp.co.kr/job/posting/88001",
    location: "서울", experience: "경력 3년", rawText: "상단 메뉴 공고소개 플랫폼 운영 주요업무 Kubernetes 자격요건 Linux 마감일 2026.07.26 D-5 이 공고와 비슷한 공고도 함께 살펴보세요 추천 A",
  };
  assert.equal(upsertJobPostingWithStatus(base).change, "new");
  assert.equal(upsertJobPostingWithStatus({ ...base, location: "경기 성남시", experience: "신입", rawText: base.rawText.replace("D-5", "D-4").replace("추천 A", "추천 B") }).change, "unchanged");
  assert.equal(upsertJobPostingWithStatus({ ...base, rawText: base.rawText.replace("2026.07.26", "2026.08.02") }).change, "changed");
});

test("ignores JobKorea counters and Wanted summary wording but hashes structured changes", () => {
  const jobkorea = {
    source: "jobkorea", company: "좋은회사", title: "DevOps", url: "https://www.jobkorea.co.kr/Recruit/GI_Read/90001",
    rawText: "전체 메뉴 모집요강 담당업무 AWS 운영 자격요건 Linux 지원자 현황 16명 494명 이상 찜 로그인하고 비슷한 조건의 AI추천공고 추천 채용관 A",
  };
  assert.equal(upsertJobPostingWithStatus(jobkorea).change, "new");
  assert.equal(upsertJobPostingWithStatus({ ...jobkorea, rawText: jobkorea.rawText.replace("16명", "28명").replace("494명", "511명").replace("채용관 A", "채용관 B") }).change, "unchanged");
  assert.equal(upsertJobPostingWithStatus({ ...jobkorea, rawText: jobkorea.rawText.replace("AWS 운영", "GCP 운영") }).change, "changed");

  const wanted = {
    source: "wanted", company: "좋은회사", title: "SRE", url: "https://www.wanted.co.kr/wd/90001",
    location: "서울 서초구", experience: "경력 3년", rawText: "요약: AWS를 운영합니다. 마감 2026.08.31",
  };
  assert.equal(upsertJobPostingWithStatus(wanted).change, "new");
  assert.equal(upsertJobPostingWithStatus({ ...wanted, rawText: "업무: 클라우드 AWS 운영. 2026/08/31까지" }).change, "unchanged");
  assert.equal(upsertJobPostingWithStatus({ ...wanted, location: "서울특별시 서초구 서초대로 1", experience: "3년 이상의 경력" }).change, "unchanged");
  assert.equal(upsertJobPostingWithStatus({ ...wanted, location: "서울시 서초구 서초대로38길 12 마제스타시티 타워", experience: "경력 3년" }).change, "unchanged");
  assert.equal(upsertJobPostingWithStatus({ ...wanted, location: "경기도 성남시 분당구" }).change, "changed");
});

test("migrates an old content hash without requeueing an unchanged assessment", async () => {
  const fixture = {
    source: "remember", company: "좋은회사", title: "Platform Engineer", url: "https://career.rememberapp.co.kr/job/posting/99002",
    rawText: "주요업무 Kubernetes 운영 자격요건 Linux",
  };
  const id = upsertJobPosting(fixture);
  await filterJobs({ assess: async () => ({ decision: "pass", summary: "적합", reasons: [], concerns: [], evidence: [] }) });
  jobDb.prepare("UPDATE job_postings SET content_hash='legacy-hash' WHERE id=?").run(id);
  jobDb.prepare("UPDATE job_assessments SET content_hash='legacy-hash' WHERE posting_id=?").run(id);
  assert.equal(upsertJobPostingWithStatus(fixture).change, "unchanged");
  const row = jobDb.prepare("SELECT p.content_hash, a.content_hash AS assessed_hash, q.state FROM job_postings p JOIN job_assessments a ON a.posting_id=p.id JOIN job_filter_queue q ON q.posting_id=p.id WHERE p.id=?").get(id);
  assert.equal(row.assessed_hash, row.content_hash);
  assert.equal(row.state, "done");
});

test("recovers an abandoned reviewing job instead of treating the queue as empty", () => {
  const id = upsertJobPosting({ source: "fixture", company: "좋은회사", title: "Lease test", url: "https://example.test/lease", rawText: "AWS" });
  assert.equal(markJobFiltering(id), true);
  jobDb.prepare("UPDATE job_filter_queue SET updated_at='2000-01-01T00:00:00.000Z' WHERE posting_id=?").run(id);
  assert.equal(recoverStaleJobFilterClaims(), 1);
  assert.equal(jobDb.prepare("SELECT state FROM job_filter_queue WHERE posting_id=?").get(id).state, "error");
});

test("does not fail a completed daily run because an earlier filter attempt was retried successfully", () => {
  const result = summarizeJobsDailyRun({
    collection: [{ source: "wanted", count: 1 }],
    verification: { results: [{ company: "좋은회사", verification: {} }] },
    filtering: [{ id: "a", error: "temporary timeout" }, { id: "a", decision: "pass" }],
    queue: { ready: true, pending: 0, reviewing: 0, retryableErrors: 0, terminalErrors: 0, staleAssessments: 0 },
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.transientFilterErrors, ["temporary timeout"]);
});

test("periodically refreshes only stale active Wanted assessments", () => {
  const fixtures = [
    { source: "wanted", suffix: "stale", assessedAt: "2000-01-01T00:00:00.000Z", active: 1 },
    { source: "wanted", suffix: "recent", assessedAt: new Date().toISOString(), active: 1 },
    { source: "remember", suffix: "remember", assessedAt: "2000-01-01T00:00:00.000Z", active: 1 },
    { source: "wanted", suffix: "inactive", assessedAt: "2000-01-01T00:00:00.000Z", active: 0 },
  ];
  for (const fixture of fixtures) {
    const id = upsertJobPosting({
      source: fixture.source, company: "좋은회사", title: `Periodic ${fixture.suffix}`,
      url: `https://example.test/periodic-${fixture.suffix}`, rawText: "AWS",
    });
    const hash = jobDb.prepare("SELECT content_hash FROM job_postings WHERE id=?").get(id).content_hash;
    jobDb.prepare(`
      INSERT OR REPLACE INTO job_assessments(posting_id, content_hash, profile_fingerprint, decision, result_json, model, assessed_at, verification_fingerprint)
      VALUES (?, ?, 'profile', 'pass', '{}', 'fixture', ?, 'verification')
    `).run(id, hash, fixture.assessedAt);
    jobDb.prepare("UPDATE job_filter_queue SET state='done' WHERE posting_id=?").run(id);
    if (!fixture.active) jobDb.prepare("UPDATE job_postings SET active=0 WHERE id=?").run(id);
    fixture.id = id;
  }
  assert.equal(queueStaleWantedAssessments(), 1);
  const state = (fixture) => jobDb.prepare("SELECT state, reason FROM job_filter_queue WHERE posting_id=?").get(fixture.id);
  assert.deepEqual({ ...state(fixtures[0]) }, { state: "pending", reason: "periodic_refresh" });
  assert.equal(state(fixtures[1]).state, "done");
  assert.equal(state(fixtures[2]).state, "done");
  assert.equal(state(fixtures[3]).state, "done");
});
