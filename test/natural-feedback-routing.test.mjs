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

let messageId = 900;
globalThis.fetch = async () => ({
  ok: true, status: 200,
  json: async () => ({ ok: true, result: { message_id: messageId += 1, date: 1 } }),
});

const {
  jobApplicationStatus, jobDb, saveJobDigestItems, upsertJobPosting,
} = await import("../src/apps/jobs/db.mjs");
const { jobsBotModule } = await import("../src/apps/jobs/bot-module.mjs");
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
  assert.equal(jobApplicationStatus(second), "ignored");
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
  const payload = JSON.parse(platformDb.prepare("SELECT payload_json FROM telegram_outbox ORDER BY id DESC LIMIT 1").get().payload_json);
  assert.match(payload.text, /어느 공고를 말하는지/);
});
