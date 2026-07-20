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
const { jobsBotModule } = await import("../src/apps/jobs/bot-module.mjs");
const { createInboxItem } = await import("../src/apps/inbox/store.mjs");

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
  assert.equal(await jobsBotModule.handleMessage({
    message_id: 5001, text: `${target.index}번 지원했어`, chat: { id: 1 },
    reply_to_message: { message_id: delivered.message_id },
  }, {
    ...context,
    semantic: {
      route: "feedback", domain: "jobs", targetIndex: target.index, feedbackIntent: "applied",
      scope: "item", strength: "high", preference: "지원 완료", keywords: [], aspects: [],
      confidence: 99, reason: "지원 완료를 명시함",
    },
  }), true);
  assert.equal(jobApplicationStatus(jobId), "applied");
});

test("shows only the remaining housing recommendations on request", async () => {
  const delivered = await sendMoreRecommendations("housing", { offset: 3, limit: 6 });
  const row = platformDb.prepare("SELECT payload_json, context_json FROM telegram_outbox WHERE message_id=?").get(delivered.message_id);
  const payload = JSON.parse(row.payload_json);
  const context = JSON.parse(row.context_json);
  assert.match(payload.text, /주택 추천/);
  assert.equal(context.items.length, 1);
  assert.equal(context.items[0].domain, "housing");
});

test("executes globally interpreted recommendation navigation in the briefing app", async () => {
  const context = { semantic: { route: "recommendations_list", domain: "jobs" } };
  assert.equal(briefingBotModule.canHandleMessage({}, context), true);
  assert.equal(await briefingBotModule.handleMessage({ text: "채용 다 보여줘" }, context), true);
  const row = platformDb.prepare("SELECT context_json FROM telegram_outbox ORDER BY id DESC LIMIT 1").get();
  assert.equal(JSON.parse(row.context_json).domain, "jobs");
});

test("keeps Inbox actions replyable without adding action buttons", async () => {
  const inbox = createInboxItem({
    kind: "task", title: "보험 갱신", nextAction: "보험사 전화",
    sourceMessageId: 9901,
  });
  setPlatformSetting("morning_briefing_housing_signature", "");
  setPlatformSetting("morning_briefing_jobs_signature", "");
  const delivered = await sendMorningBriefing({ now: new Date("2026-07-21T00:00:00.000Z") });
  const row = platformDb.prepare("SELECT payload_json, context_json FROM telegram_outbox WHERE message_id=?").get(delivered.message_id);
  const payload = JSON.parse(row.payload_json);
  const context = JSON.parse(row.context_json);
  const inboxContext = context.items.find((item) => item.domain === "inbox");
  assert.equal(inboxContext.id, inbox.id);
  assert.match(payload.text, /보험사 전화/);
  assert.equal(payload.reply_markup.inline_keyboard.some((buttons) => buttons[0].callback_data.includes(`:${inbox.id}`)), false);
});

test("does not repeat an Inbox event that already has the same approved reminder", () => {
  const inbox = createInboxItem({
    kind: "event", title: "중복 방지 일정", nextAction: "참석",
    eventAt: "2026-07-21T06:00:00.000Z", sourceMessageId: 9902,
  });
  const reminder = createReminder({
    title: inbox.title, dueAt: inbox.event_at, module: "global", entityKey: `inbox:${inbox.id}`,
  });
  setReminderStatus(reminder.id, "approved");
  const snapshot = morningBriefingSnapshot({ now: new Date("2026-07-21T00:00:00.000Z") });
  assert.equal(snapshot.actions.some((item) => item.title === inbox.title), true);
  assert.equal(snapshot.inbox.some((item) => item.id === inbox.id), false);
});
