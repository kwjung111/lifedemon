import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "lifedemon-followup-"));
process.env.MONITOR_DATA_DIR = dataDir;
process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.TELEGRAM_CHAT_ID = "1";

const { housingApplicationFollowup } = await import("../src/apps/housing/application-followup.mjs");
const { jobApplicationFollowup } = await import("../src/apps/jobs/application-followup.mjs");
const { platformDb } = await import("../src/core/state.mjs");

test.after(() => {
  platformDb.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test("extracts an exact housing result time and configures dynamic official-link resolution", () => {
  const reminder = housingApplicationFollowup({
    id: "housing-1", source: "SH", title: "2026년 2차 청년 매입임대주택 입주자 모집",
    url: "https://example.test/housing",
    raw_text: "서류심사대상자 발표 2026.08.20. 오후 4시",
    announcement_date: "2026-08-20",
  }, { now: new Date("2026-07-20T00:00:00.000Z") });
  assert.equal(reminder.dueAt, "2026-08-20T07:00:00.000Z");
  assert.equal(reminder.resolver, "housing-official");
  assert.equal(reminder.metadata.assumedTime, false);
  assert.deepEqual(reminder.metadata.keywords, ["2026년 2차", "청년", "매입임대주택"]);
});

test("uses an explicit morning fallback only when the official housing time is absent", () => {
  const reminder = housingApplicationFollowup({
    id: "housing-2", source: "LH", title: "청년 전세임대 입주자 모집",
    url: "https://example.test/lh", announcement_date: "2026-08-21", raw_text: "당첨자 발표 예정",
  }, { now: new Date("2026-07-20T00:00:00.000Z") });
  assert.equal(reminder.dueAt, "2026-08-21T00:00:00.000Z");
  assert.equal(reminder.metadata.assumedTime, true);
});

test("proposes a job follow-up only when a personalized event has an exact future time", () => {
  const reminder = jobApplicationFollowup({
    id: "job-1", company: "테스트", title: "DevOps", url: "https://example.test/job",
    raw_text: "1차 면접: 2026-08-22 14:30 온라인",
  }, { now: new Date("2026-07-20T00:00:00.000Z") });
  assert.equal(reminder.dueAt, "2026-08-22T05:30:00.000Z");
  assert.equal(jobApplicationFollowup({ id: "job-2", raw_text: "채용 시 마감" }), null);
});
