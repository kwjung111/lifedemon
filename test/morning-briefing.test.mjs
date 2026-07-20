import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "lifedemon-briefing-"));
const housingProfile = join(dataDir, "housing-profile.json");
const jobProfile = join(dataDir, "job-profile.json");
const companies = join(dataDir, "companies.json");
writeFileSync(housingProfile, JSON.stringify({ birthDate: "1990-01-01", householdSize: 1 }));
writeFileSync(jobProfile, JSON.stringify({
  preferences: { preferredRoles: ["DevOps"], excludedRoles: ["Backend"] },
  companyFilters: {
    jobplanet: { minimumRating: 2.5, excludeWhenMissing: true },
    minimumEmployeeCount: 10,
  },
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
process.env.FEEDBACK_AI_ENABLED = "false";

let telegramMessageId = 1200;
globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  json: async () => ({ ok: true, result: { message_id: telegramMessageId += 1, date: 1 } }),
});

const {
  db: housingDb, setApplication, setSetting, upsertNotice,
} = await import("../src/db.mjs");
const {
  jobApplicationStatus, jobDb, saveJobAssessment, setJobSetting, upsertJobPosting,
} = await import("../src/apps/jobs/db.mjs");
const { companyVerificationFingerprint, loadAuthorizedCompanyVerifications } = await import("../src/apps/jobs/company-verification.mjs");
const { jobProfileFingerprint, loadJobProfile } = await import("../src/apps/jobs/profile.mjs");
const {
  createReminder, platformDb, setPlatformSetting, setReminderStatus,
} = await import("../src/core/state.mjs");
const {
  formatMorningBriefing, morningBriefingSnapshot, sendMorningBriefing, sendMoreRecommendations,
} = await import("../src/apps/briefing/report.mjs");
const { briefingBotModule } = await import("../src/apps/briefing/bot-module.mjs");

function housingFixture(index) {
  return {
    id: `housing-${index}`, source: "SH", title: `청년 매입임대 ${index}`,
    url: `https://www.i-sh.co.kr/housing/${index}`, verdict: "likely",
    categories: ["청년"], reasons: ["서울 청년"], rawText: "공식 공고",
    applyEnd: "2026-07-30",
  };
}

for (let index = 1; index <= 5; index += 1) upsertNotice(housingFixture(index));
const jobId = upsertJobPosting({
  source: "wanted", company: "브리핑회사", title: "DevOps Engineer",
  url: "https://www.wanted.co.kr/wd/7771", rawText: "AWS Kubernetes Terraform",
});
const job = jobDb.prepare("SELECT * FROM job_postings WHERE id=?").get(jobId);
saveJobAssessment(
  job,
  { decision: "pass", summary: "적합", reasons: [], concerns: [], evidence: [] },
  jobProfileFingerprint(loadJobProfile()),
  companyVerificationFingerprint(loadAuthorizedCompanyVerifications()),
);
setSetting("housing_collection_last_summary", JSON.stringify({
  completedAt: "2026-07-21T00:00:00.000Z",
  summary: [{ source: "SH", count: 5, newCount: 2, changedCount: 1 }],
}));
setJobSetting("job_collection_last_summary", JSON.stringify({
  completedAt: "2026-07-21T00:10:00.000Z",
  summary: [{ source: "wanted", count: 1, newCount: 1, changedCount: 0 }],
}));
const reminder = createReminder({
  title: "서류심사대상자 발표", dueAt: "2026-07-21T07:00:00.000Z",
  url: "https://www.i-sh.co.kr/result",
});
setReminderStatus(reminder.id, "approved");
setApplication("housing-5", "applied", { announcementDate: "2026-07-21" });

test.after(() => {
  platformDb.close();
  housingDb.close();
  jobDb.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test("formats one bounded briefing with actions and only top recommendations", () => {
  const snapshot = morningBriefingSnapshot({ now: new Date("2026-07-21T00:00:00.000Z") });
  const report = formatMorningBriefing(snapshot);
  assert.match(report.text, /오늘 할 일 2개/);
  assert.match(report.text, /주택 · 추천 후보 4건/);
  assert.match(report.text, /신규 2 · 변경 1/);
  assert.match(report.text, /브리핑회사 — DevOps Engineer/);
  assert.equal(report.items.filter((item) => item.domain === "housing").length, 3);
  assert.equal(report.items.filter((item) => item.domain === "jobs").length, 1);
  assert.ok(report.text.length < 4000);
});

test("collapses unchanged domains to an explicit one-line status", () => {
  const first = morningBriefingSnapshot({ now: new Date("2026-07-21T00:00:00.000Z") });
  setPlatformSetting("morning_briefing_housing_signature", first.housing.signature);
  setPlatformSetting("morning_briefing_jobs_signature", first.jobs.signature);
  setSetting("housing_collection_last_summary", JSON.stringify({ completedAt: "later", summary: [] }));
  setJobSetting("job_collection_last_summary", JSON.stringify({ completedAt: "later", summary: [] }));
  const text = formatMorningBriefing(morningBriefingSnapshot({ now: new Date("2026-07-21T00:00:00.000Z") })).text;
  assert.equal((text.match(/변경 없음/g) || []).length, 2);
});

test("routes a mixed briefing number to the correct application tracker", async () => {
  setPlatformSetting("morning_briefing_housing_signature", "");
  setPlatformSetting("morning_briefing_jobs_signature", "");
  const delivered = await sendMorningBriefing({ now: new Date("2026-07-21T00:00:00.000Z") });
  const row = platformDb.prepare("SELECT context_json FROM telegram_outbox WHERE message_id=?").get(delivered.message_id);
  const context = JSON.parse(row.context_json);
  const target = context.items.find((item) => item.domain === "jobs");
  assert.ok(target);
  assert.equal(await briefingBotModule.handleMessage({
    message_id: 5001, text: `${target.index}번 지원했어`, chat: { id: 1 },
    reply_to_message: { message_id: delivered.message_id },
  }), true);
  assert.equal(jobApplicationStatus(jobId), "applied");
});

test("shows only the remaining housing recommendations on request", async () => {
  const delivered = await sendMoreRecommendations("housing", { offset: 3, limit: 6 });
  const row = platformDb.prepare("SELECT payload_json, context_json FROM telegram_outbox WHERE message_id=?").get(delivered.message_id);
  const payload = JSON.parse(row.payload_json);
  const context = JSON.parse(row.context_json);
  assert.match(payload.text, /주택 추가 추천/);
  assert.equal(context.items.length, 1);
  assert.equal(context.items[0].domain, "housing");
});
