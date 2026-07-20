import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "lifedemon-results-"));
process.env.HOUSING_DATA_DIR = dataDir;
process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.TELEGRAM_CHAT_ID = "1";

const {
  applicationResult,
  appliedNotices,
  db,
  recentApplicationResults,
  saveApplicationResult,
  setApplication,
  setHousingRecommendationFeedback,
  upsertNotice,
} = await import("../src/db.mjs");
const { housingResultKeywords, runHousingResultChecks } = await import("../src/apps/housing/result-checker.mjs");
const { rankHousingCandidates } = await import("../src/report.mjs");

test.after(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function fixture(id = "result-a") {
  return {
    id, source: "SH", title: "2026년 1차 청년 매입임대주택 입주자모집(2026.6.26.)",
    url: "https://www.i-sh.co.kr/example", verdict: "likely", categories: [], reasons: [], rawText: "fixture",
  };
}

test("extracts stable official-result keywords from a housing notice title", () => {
  assert.deepEqual(housingResultKeywords(fixture().title), ["2026년 1차", "청년", "매입임대주택"]);
  assert.deepEqual(housingResultKeywords("임대주택 모집공고"), []);
});

test("prompts once after finding an official result and stops after outcome recording", async () => {
  const id = upsertNotice(fixture());
  setApplication(id, "applied", { announcementDate: "2026-07-20" });
  const originalAppliedAt = appliedNotices()[0].applied_at;
  const messages = [];
  const discover = async () => ({ found: true, url: "https://www.i-sh.co.kr/result", matchedTitle: "서류심사대상자 발표" });
  const send = async (text, options) => {
    messages.push({ text, options });
    return { message_id: 701 };
  };

  const first = await runHousingResultChecks({ now: new Date("2026-07-20T08:00:00Z"), discover, send });
  const second = await runHousingResultChecks({ now: new Date("2026-07-20T15:00:00Z"), discover, send });
  assert.equal(first[0].prompted, true);
  assert.equal(second[0].prompted, false);
  assert.equal(messages.length, 1);

  saveApplicationResult(id, { stage: "document", outcome: "not_selected", source: "test", cutoffPriority: 1, cutoffScore: 5, supplyUnits: 21 });
  assert.equal(applicationResult(id).outcome, "not_selected");
  assert.equal(appliedNotices().length, 0);
  assert.equal(recentApplicationResults()[0].supply_units, 21);
  assert.equal(db.prepare("SELECT applied_at FROM applications WHERE notice_id=?").get(id).applied_at, originalAppliedAt);
});

test("ranks evidenced second- and third-priority supply ahead when feedback enables it", () => {
  setHousingRecommendationFeedback("공급호수가 많고 2·3순위까지 내려간 매물을 우선 추천");
  const candidates = [
    { id: "high-score", ai_score: 90, ai_result_json: JSON.stringify({ units: "10호", target_conditions: "1순위" }) },
    { id: "feedback-fit", ai_score: 70, ai_result_json: JSON.stringify({ units: "40호", target_conditions: "3순위까지 공급" }) },
  ];
  assert.equal(rankHousingCandidates(candidates)[0].id, "feedback-fit");
});

test("a weak semantic preference cannot overwhelm a large official score gap", () => {
  const candidates = [
    { id: "strong", ai_score: 95, title: "일반 공공임대", ai_result_json: "{}" },
    { id: "weak-liked", ai_score: 10, title: "청년안심주택", ai_result_json: "{}" },
  ];
  const preferences = [{
    entityId: "old", scope: "housing_type", sentiment: "positive", keyword: "청년안심주택", strength: "low",
  }];
  assert.equal(rankHousingCandidates(candidates, { preference: "", outcomes: [] }, preferences)[0].id, "strong");
});
