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

const { companyGate, loadAuthorizedCompanyVerifications } = await import("../src/apps/jobs/company-verification.mjs");
const { jobDb, pendingJobFilters, upsertJobPosting } = await import("../src/apps/jobs/db.mjs");
const { filterJobs, normalizeJobAssessment } = await import("../src/apps/jobs/filter.mjs");
const { jobDiscoveryQueries, jobProfileFingerprint, loadJobProfile } = await import("../src/apps/jobs/profile.mjs");

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
