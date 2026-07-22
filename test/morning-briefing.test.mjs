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
  db: housingDb, markReviewing, pendingReviewNotices, saveNoticeReview, setApplication, setSetting, upsertNotice,
} = await import("../src/db.mjs");
const {
  jobApplicationStatus, jobDb, markJobFiltering, saveJobAssessment, setJobSetting, upsertJobPosting,
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
const { executeRecommendationAgentTool, recommendationAgentItems } = await import("../src/apps/feedback/agent.mjs");
const { createInboxItem } = await import("../src/apps/inbox/store.mjs");
const { briefingDeliveryKey, waitForMorningBriefingReadiness } = await import("../src/apps/briefing/scheduled.mjs");

function housingFixture(index) {
  return {
    id: `housing-${index}`, source: "SH", title: `청년 매입임대 ${index}`,
    url: `https://www.i-sh.co.kr/housing/${index}`, verdict: "likely",
    categories: ["청년"], reasons: ["서울 청년"], rawText: "공식 공고",
    applyEnd: "2026-07-30",
  };
}

for (let index = 1; index <= 5; index += 1) upsertNotice(housingFixture(index));
for (const notice of pendingReviewNotices(100)) {
  markReviewing(notice);
  saveNoticeReview(notice, {
    eligibility: "yes", score: 70, status: "open", summary: "검토 완료",
    reasons: [], cautions: [], evidence: [], target_conditions: [], units: null, needs: [],
  });
}
const jobId = upsertJobPosting({
  source: "wanted", company: "브리핑회사", title: "DevOps Engineer",
  url: "https://www.wanted.co.kr/wd/7771", rawText: "AWS Kubernetes Terraform",
});
const job = jobDb.prepare("SELECT * FROM job_postings WHERE id=?").get(jobId);
markJobFiltering(jobId);
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
setSetting("housing_review_last_summary", JSON.stringify({
  completedAt: "2026-07-21T00:05:00.000Z", reviews: [],
}));
setJobSetting("job_collection_last_summary", JSON.stringify({
  completedAt: "2026-07-21T00:10:00.000Z",
  summary: [{ source: "wanted", count: 1, newCount: 1, changedCount: 0 }],
}));
setJobSetting("jobs_daily_last_run", JSON.stringify({
  date: "2026-07-21", status: "completed", phase: "finished", completedAt: "2026-07-21T00:20:00.000Z",
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
  setSetting("housing_collection_last_summary", JSON.stringify({ completedAt: "2026-07-21T00:30:00.000Z", summary: [] }));
  setJobSetting("job_collection_last_summary", JSON.stringify({ completedAt: "2026-07-21T00:30:00.000Z", summary: [] }));
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
  const items = recommendationAgentItems(context);
  const result = await executeRecommendationAgentTool({
    tool: "track_application", domain: "jobs", target_index: target.index, target_indexes: [],
    intent: null, scope: null, strength: null, preference: null, keywords: [], aspects: [],
    rule_kind: null, rule_keyword: null,
  }, { items, text: `${target.index}번 지원했어`, messageId: 5001 });
  assert.equal(result.ok, true);
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
  const context = { semantic: { route: "recommendations_list", domain: "housing" } };
  assert.equal(briefingBotModule.canHandleMessage({}, context), true);
  assert.equal(await briefingBotModule.handleMessage({ text: "주택 다 보여줘" }, context), true);
  const row = platformDb.prepare("SELECT context_json FROM telegram_outbox ORDER BY id DESC LIMIT 1").get();
  assert.equal(JSON.parse(row.context_json).domain, "housing");
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

test("hides recommendations and explains a terminal AI queue failure", () => {
  jobDb.prepare("UPDATE job_filter_queue SET state='error', attempts=3, last_error='fixture terminal' WHERE posting_id=?").run(jobId);
  const snapshot = morningBriefingSnapshot({ now: new Date("2026-07-21T00:00:00.000Z") });
  const report = formatMorningBriefing(snapshot);
  assert.equal(snapshot.jobs.readiness.ready, false);
  assert.equal(snapshot.jobs.readiness.fatal, true);
  assert.match(report.text, /채용 · 준비 미완료/);
  assert.match(report.text, /AI 최종 실패 1건/);
  assert.doesNotMatch(report.text, /브리핑회사 — DevOps Engineer/);
  jobDb.prepare("UPDATE job_filter_queue SET state='done', attempts=1, last_error=NULL WHERE posting_id=?").run(jobId);
});

test("counts an officially empty housing source as success rather than an error", () => {
  setSetting("housing_collection_last_summary", JSON.stringify({
    completedAt: "2026-07-21T00:30:00.000Z",
    summary: [{ source: "HUG", status: "empty", count: 0 }],
  }));
  const snapshot = morningBriefingSnapshot({ now: new Date("2026-07-21T00:00:00.000Z") });
  assert.equal(snapshot.housing.errors, 0);
  assert.deepEqual(snapshot.housing.emptySources, ["HUG"]);
  assert.match(formatMorningBriefing(snapshot).text, /공고 없음: HUG/);
});

test("waits for readiness and uses separate complete and blocked delivery keys", async () => {
  let currentTime = 0;
  const waiting = {
    date: "2026-07-21", readiness: { ready: false, fatal: false, settled: false },
  };
  const ready = { date: "2026-07-21", readiness: { ready: true, fatal: false, settled: true } };
  let polls = 0;
  const result = await waitForMorningBriefingReadiness({
    timeoutMs: 100, pollMs: 25, clock: () => currentTime,
    sleep: async (milliseconds) => { currentTime += milliseconds; },
    snapshot: () => (++polls >= 3 ? ready : waiting),
  });
  assert.equal(result.snapshot.readiness.ready, true);
  assert.equal(briefingDeliveryKey(ready), "morning-briefing:2026-07-21");
  assert.equal(briefingDeliveryKey({ ...waiting, readiness: { ready: false, fatal: true } }), "morning-briefing-blocked:2026-07-21");
});

test("keeps waiting for a running domain after the other domain has already failed", async () => {
  let currentTime = 0;
  let polls = 0;
  const housingFailedJobsRunning = {
    date: "2026-07-21", readiness: { ready: false, fatal: true, settled: false },
  };
  const housingFailedJobsReady = {
    date: "2026-07-21", readiness: { ready: false, fatal: true, settled: true },
  };
  const result = await waitForMorningBriefingReadiness({
    timeoutMs: 100, pollMs: 25, clock: () => currentTime,
    sleep: async (milliseconds) => { currentTime += milliseconds; },
    snapshot: () => (++polls >= 2 ? housingFailedJobsReady : housingFailedJobsRunning),
  });
  assert.equal(polls, 2);
  assert.equal(result.timedOut, false);
  assert.equal(result.snapshot.readiness.settled, true);
});

test("waits for today's run instead of treating yesterday's collection error as immediately fatal", () => {
  setSetting("housing_collection_last_summary", JSON.stringify({
    completedAt: "2026-07-20T00:30:00.000Z", summary: [{ source: "HUG", error: "old failure" }],
  }));
  setSetting("housing_review_last_summary", JSON.stringify({
    completedAt: "2026-07-20T00:40:00.000Z", reviews: [{ error: "old review failure" }],
  }));
  const snapshot = morningBriefingSnapshot({ now: new Date("2026-07-21T00:00:00.000Z") });
  assert.equal(snapshot.housing.readiness.ready, false);
  assert.equal(snapshot.housing.readiness.fatal, false);
  assert.equal(snapshot.readiness.fatal, false);
});
