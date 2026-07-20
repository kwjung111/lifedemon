import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "life-navigation-"));
const housingProfile = join(dataDir, "housing-profile.json");
const jobProfile = join(dataDir, "job-profile.json");
const companies = join(dataDir, "companies.json");
writeFileSync(housingProfile, JSON.stringify({ birthDate: "1990-01-01", householdSize: 1 }));
writeFileSync(jobProfile, JSON.stringify({ preferences: {}, companyFilters: {} }));
writeFileSync(companies, "[]");
process.env.MONITOR_DATA_DIR = dataDir;
process.env.HOUSING_DATA_DIR = dataDir;
process.env.JOB_DATA_DIR = dataDir;
process.env.HOUSING_USER_PROFILE_FILE = housingProfile;
process.env.JOB_USER_PROFILE_FILE = jobProfile;
process.env.JOB_COMPANY_VERIFICATION_FILE = companies;
process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.TELEGRAM_CHAT_ID = "1";
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, result: {} }) });

const {
  classifyNavigationIntent, navigationIntentPrompt, normalizeNavigationIntent,
} = await import("../src/apps/navigation/ai-parser.mjs");
const { createNavigationBotModule } = await import("../src/apps/navigation/bot-module.mjs");
const { platformDb } = await import("../src/core/state.mjs");
const { db: housingDb } = await import("../src/db.mjs");
const { jobDb } = await import("../src/apps/jobs/db.mjs");

test.after(() => {
  platformDb.close(); housingDb.close(); jobDb.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test("asks AI to interpret recommendation navigation without phrase regexes", async () => {
  let prompt = "";
  const result = await classifyNavigationIntent("채용 싹 다 꺼내줘.", null, {
    env: {},
    codexRunner: async (options) => {
      prompt = options.prompt;
      return {
        intent: "show_recommendations", domain: "jobs", confidence: 96,
        reason: "채용 추천 전체를 보고 싶다는 요청",
      };
    },
  });
  assert.equal(result.intent, "show_recommendations");
  assert.equal(result.domain, "jobs");
  assert.match(prompt, /채용 싹 다 꺼내줘/);
  assert.doesNotMatch(navigationIntentPrompt("아무 말"), /정규식|regex/i);
});

test("fails closed when the AI is uncertain or omits the domain", () => {
  assert.equal(normalizeNavigationIntent({
    intent: "show_recommendations", domain: "jobs", confidence: 50, reason: "모호함",
  }).intent, "not_navigation");
  assert.equal(normalizeNavigationIntent({
    intent: "next_page", domain: null, confidence: 99, reason: "영역 없음",
  }).intent, "not_navigation");
});

test("routes an AI-classified natural job request to the first bounded page", async () => {
  const calls = [];
  const module = createNavigationBotModule({
    classify: async () => ({ intent: "show_recommendations", domain: "jobs", confidence: 99 }),
    sendMore: async (...args) => calls.push(args),
    typing: () => {},
  });
  assert.equal(await module.handleMessage({ text: "채용 다 보여줘.", chat: { id: 1 } }), true);
  assert.deepEqual(calls, [["jobs", { offset: 0 }]]);
});

test("uses reply context when AI recognizes a generic next-page request", async () => {
  const calls = [];
  const module = createNavigationBotModule({
    classify: async () => ({ intent: "next_page", domain: "jobs", confidence: 98 }),
    sendMore: async (...args) => calls.push(args),
    typing: () => {},
  });
  const context = { domain: "jobs", kind: "digest", nextOffset: 12, items: [{ id: "a" }] };
  assert.equal(module.canHandleMessage({}, context), true);
  assert.equal(await module.handleMessage({ text: "계속 보여줘", chat: { id: 1 } }, context), true);
  assert.deepEqual(calls, [["jobs", { offset: 12 }]]);
});

test("leaves feedback and unrelated messages for downstream modules", async () => {
  const module = createNavigationBotModule({
    classify: async () => ({ intent: "not_navigation", domain: null, confidence: 99 }),
    sendMore: async () => assert.fail("must not send a recommendation page"),
    typing: () => {},
  });
  assert.equal(await module.handleMessage({ text: "2번 지원했어", chat: { id: 1 } }, {
    domain: "jobs", kind: "digest", items: [{ id: "a", index: 2 }],
  }), false);
});
