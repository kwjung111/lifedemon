import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "lifedemon-manager-"));
const jobProfilePath = join(dataDir, "job-profile.json");
const housingProfilePath = join(dataDir, "housing-profile.json");
writeFileSync(jobProfilePath, JSON.stringify({
  preferences: {
    preferredRoles: ["DevOps", "SRE"],
    excludedRoles: ["영업"],
    discoveryQueries: ["DevOps", "Platform Engineer"],
  },
  companyFilters: {
    jobplanet: { minimumRating: 3, excludeWhenMissing: true },
    minimumEmployeeCount: 11,
  },
}));
writeFileSync(housingProfilePath, JSON.stringify({ householdSize: 1 }));
process.env.MONITOR_DATA_DIR = dataDir;
process.env.HOUSING_DATA_DIR = dataDir;
process.env.JOB_DATA_DIR = dataDir;
process.env.JOB_USER_PROFILE_FILE = jobProfilePath;
process.env.HOUSING_USER_PROFILE_FILE = housingProfilePath;
process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.TELEGRAM_CHAT_ID = "1";

const {
  answerManagerQuestion,
  directManagerAnswer,
  looksLikeManagerQuestion,
} = await import("../src/apps/manager/query.mjs");
const { createManagerBotModule } = await import("../src/apps/manager/bot-module.mjs");
const { buildSystemSnapshot, parseSystemctlShow } = await import("../src/apps/manager/snapshot.mjs");
const { db } = await import("../src/db.mjs");
const { jobDb, setJobSetting } = await import("../src/apps/jobs/db.mjs");
const { platformDb } = await import("../src/core/state.mjs");

test.after(() => {
  db.close();
  jobDb.close();
  platformDb.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function fixtureSnapshot() {
  return {
    version: "1.4.0",
    jobs: {
      available: true,
      profile: {
        preferences: {
          preferredRoles: ["DevOps", "SRE"],
          excludedRoles: ["영업"],
          discoveryQueries: ["DevOps", "Platform Engineer"],
        },
        companyFilters: { jobplanet: { minimumRating: 3, excludeWhenMissing: true }, minimumEmployeeCount: 11 },
      },
      collection: { lastAttemptAt: "2026-07-20T00:20:00.000Z", lastSuccessAt: "2026-07-20T00:20:00.000Z" },
      recommended: [{ company: "Example", title: "SRE", decision: "pass" }],
    },
    housing: { available: true, collection: { lastAttemptAt: "2026-07-20T00:00:00.000Z", lastSuccessAt: "2026-07-20T00:00:00.000Z" } },
    services: [
      { unit: "housing-daily.timer", available: true, ActiveState: "active", SubState: "waiting", NextElapseUSecRealtime: "Mon 2026-07-20 00:00:00 UTC" },
      { unit: "jobs-daily.timer", available: true, ActiveState: "active", SubState: "waiting", NextElapseUSecRealtime: "Mon 2026-07-20 00:20:00 UTC" },
    ],
  };
}

test("recognizes explicit and natural manager questions without claiming unrelated chat", () => {
  assert.equal(looksLikeManagerQuestion("/ask 수집이 언제 돌았지?"), true);
  assert.equal(looksLikeManagerQuestion("/job 에서 현재 내 채용공고 우선순위가 어떻게 되지?"), true);
  assert.equal(looksLikeManagerQuestion("오늘 점심 뭐 먹지?"), false);
});

test("answers common priority and collection questions deterministically", () => {
  const priority = directManagerAnswer("현재 내 채용 우선순위가 어떻게 돼?", fixtureSnapshot());
  assert.match(priority, /DevOps → SRE/);
  assert.match(priority, /잡플래닛 3점 이상/);
  assert.match(priority, /Example — SRE/);

  const collection = directManagerAnswer("수집이 마지막으로 언제 돌았지?", fixtureSnapshot());
  assert.match(collection, /마지막 성공/);
  assert.match(collection, /2026-07-20 09:20:00 KST/);
});

test("uses the bounded AI answer only for questions without a direct formatter", async () => {
  let calls = 0;
  const answer = await answerManagerQuestion("최근 주택 결과가 추천에 어떻게 반영돼?", fixtureSnapshot(), {
    run: async ({ prompt, schema }) => {
      calls += 1;
      assert.match(prompt, /SYSTEM_SNAPSHOT/);
      assert.equal(schema.additionalProperties, false);
      return { topic: "housing", answer: "최근 결과는 추천 순서에만 반영됩니다." };
    },
  });
  assert.equal(calls, 1);
  assert.equal(answer, "최근 결과는 추천 순서에만 반영됩니다.");
});

test("retries a manager question with the configured API fallback only for quota errors", async () => {
  const keys = [];
  const answer = await answerManagerQuestion("최근 주택 결과가 추천에 어떻게 반영돼?", fixtureSnapshot(), {
    env: { CODEX_API_FALLBACK_KEY: "test-api-key" },
    run: async ({ apiKey }) => {
      keys.push(apiKey);
      if (!apiKey) throw new Error("usage limit reached");
      return { topic: "housing", answer: "fallback 응답" };
    },
  });
  assert.deepEqual(keys, [null, "test-api-key"]);
  assert.equal(answer, "fallback 응답");
});

test("routes a slash-job natural question through the manager module", async () => {
  const sent = [];
  const module = createManagerBotModule({
    snapshot: () => fixtureSnapshot(),
    answer: async (question) => `질문: ${question}`,
    send: async (message) => sent.push(message),
  });
  assert.equal(await module.handleMessage({ text: "/job 에서 우선순위 알려줘" }), true);
  assert.deepEqual(sent, ["질문: /job 에서 우선순위 알려줘"]);
  assert.equal(await module.handleMessage({ text: "오늘 점심 뭐 먹지?" }), false);
});

test("builds a private snapshot and parses systemd properties without executing a shell", () => {
  setJobSetting("job_collection_last_success_at", "2026-07-20T00:20:00.000Z");
  const snapshot = buildSystemSnapshot({
    now: new Date("2026-07-20T01:00:00.000Z"),
    systemctl: (unit) => `Id=${unit}\nActiveState=active\nSubState=waiting\nResult=success\n`,
  });
  assert.equal(snapshot.jobs.profile.preferences.preferredRoles[0], "DevOps");
  assert.equal(snapshot.jobs.collection.lastSuccessAt, "2026-07-20T00:20:00.000Z");
  assert.equal(snapshot.services.every((service) => service.ActiveState === "active"), true);
  assert.deepEqual(parseSystemctlShow("ActiveState=active\nResult=success\n"), { ActiveState: "active", Result: "success" });
});
