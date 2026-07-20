import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "lifedemon-natural-feedback-"));
const housingProfile = join(dataDir, "housing-profile.json");
writeFileSync(housingProfile, JSON.stringify({ householdSize: 1 }));
process.env.MONITOR_DATA_DIR = dataDir;
process.env.HOUSING_DATA_DIR = dataDir;
process.env.JOB_DATA_DIR = dataDir;
process.env.HOUSING_USER_PROFILE_FILE = housingProfile;
process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.TELEGRAM_CHAT_ID = "1";
process.env.FEEDBACK_AI_ENABLED = "false";

let messageId = 900;
globalThis.fetch = async () => ({
  ok: true, status: 200,
  json: async () => ({ ok: true, result: { message_id: messageId += 1, date: 1 } }),
});

const {
  jobApplicationStatus, jobDb, jobRecommendationHidden, saveJobDigestItems,
  setJobApplication, setJobRecommendationHidden, upsertJobPosting,
} = await import("../src/apps/jobs/db.mjs");
const { createJobsBotModule, jobsBotModule } = await import("../src/apps/jobs/bot-module.mjs");
const { platformDb, recentFeedbackEvents } = await import("../src/core/state.mjs");
const { db: housingDb } = await import("../src/db.mjs");

const first = upsertJobPosting({
  source: "wanted", company: "(주)콘텐츠브릿지", title: "클라우드 운영 엔지니어",
  url: "https://example.test/one", rawText: "공고 1",
});
const second = upsertJobPosting({
  source: "wanted", company: "(주)위시켓", title: "Azure Solutions Architect",
  url: "https://example.test/two", rawText: "공고 2",
});
saveJobDigestItems(500, [{ index: 1, id: first }, { index: 2, id: second }]);

test.after(() => {
  platformDb.close();
  jobDb.close();
  housingDb.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test("routes company-name feedback without a rigid numbered phrase", async () => {
  assert.equal(await jobsBotModule.handleMessage({
    text: "위시켓은 좀 미묘한데", reply_to_message: { message_id: 500 },
  }), true);
  assert.equal(jobApplicationStatus(second), null);
  assert.equal(jobRecommendationHidden(second), true);
  const event = recentFeedbackEvents()[0];
  assert.equal(event.entity_id, second);
  assert.equal(event.signal, "negative");
});

test("routes a natural ordinal positive preference", async () => {
  assert.equal(await jobsBotModule.handleMessage({
    text: "첫 번째가 제일 나아 보이네", reply_to_message: { message_id: 500 },
  }), true);
  const event = recentFeedbackEvents()[0];
  assert.equal(event.entity_id, first);
  assert.equal(event.signal, "positive");
});

test("asks one short question when a multi-item reply is ambiguous", async () => {
  const before = recentFeedbackEvents().length;
  assert.equal(await jobsBotModule.handleMessage({
    text: "이건 괜찮아 보이는데", reply_to_message: { message_id: 500 },
  }), true);
  assert.equal(recentFeedbackEvents().length, before);
  const question = platformDb.prepare("SELECT * FROM telegram_outbox ORDER BY id DESC LIMIT 1").get();
  const payload = JSON.parse(question.payload_json);
  assert.match(payload.text, /어느 공고를 말하는지/);
  assert.equal(JSON.parse(question.context_json).pendingFeedback, "이건 괜찮아 보이는데");

  assert.equal(await jobsBotModule.handleMessage({
    text: "2번", reply_to_message: { message_id: question.message_id },
  }), true);
  assert.equal(recentFeedbackEvents()[0].entity_id, second);
  assert.equal(recentFeedbackEvents()[0].signal, "positive");
});

test("preserves applied tracking while negative AI feedback hides only the recommendation", async () => {
  const id = upsertJobPosting({
    source: "wanted", company: "지원추적회사", title: "Backend Engineer",
    url: "https://example.test/applied-negative", rawText: "백엔드",
  });
  saveJobDigestItems(501, [{ index: 1, id }]);
  setJobApplication(id, "applied");
  const module = createJobsBotModule({
    aiEnabled: () => true,
    interpret: async () => ({
      intent: "negative", targetIndex: 1, scope: "job_role", strength: "medium",
      preference: "백엔드 직무는 선호하지 않음", keywords: ["백엔드"],
      aspects: [{ scope: "job_role", sentiment: "negative", keyword: "백엔드", reason: "직무 불호" }],
      confidence: 98, reason: "직무에 대한 명확한 불호", source: "ai",
    }),
  });
  await module.handleMessage({ text: "직무는 별로지만 면접은 볼 거야", chat: { id: 1 }, reply_to_message: { message_id: 501 } });
  assert.equal(jobApplicationStatus(id), "applied");
  assert.equal(jobRecommendationHidden(id), true);
});

test("stores mixed AI aspects without hiding the current posting", async () => {
  setJobRecommendationHidden(second, false);
  const module = createJobsBotModule({
    aiEnabled: () => true,
    interpret: async () => ({
      intent: "mixed", targetIndex: 2, scope: "item", strength: "high",
      preference: "회사는 좋지만 직무는 비선호", keywords: ["위시켓", "Azure"],
      aspects: [
        { scope: "company", sentiment: "positive", keyword: "(주)위시켓", reason: "회사 선호" },
        { scope: "job_role", sentiment: "negative", keyword: "Azure", reason: "직무 비선호" },
      ],
      confidence: 97, reason: "상반된 측면", source: "ai",
    }),
  });
  await module.handleMessage({ text: "위시켓 회사는 좋은데 직무는 별로", chat: { id: 1 }, reply_to_message: { message_id: 500 } });
  const event = recentFeedbackEvents()[0];
  assert.equal(event.signal, "mixed");
  assert.equal(JSON.parse(event.metadata_json).interpretation.aspects.length, 2);
  assert.equal(jobRecommendationHidden(second), false);
});
