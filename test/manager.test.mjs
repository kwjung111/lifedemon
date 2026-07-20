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
const { diagnosticDecisionSchema, runReadOnlyDiagnosticAgent } = await import("../src/apps/manager/agent.mjs");
const { executeReadOnlyTool } = await import("../src/apps/manager/read-only-tools.mjs");
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
  assert.equal(looksLikeManagerQuestion("그거 왜 실패했지?"), true);
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

test("routes nontrivial questions to the read-only diagnostic agent", async () => {
  let calls = 0;
  const answer = await answerManagerQuestion("최근 주택 결과가 추천에 어떻게 반영돼?", fixtureSnapshot(), {
    agent: async ({ question, snapshot }) => {
      calls += 1;
      assert.match(question, /주택 결과/);
      assert.equal(snapshot.version, "1.4.0");
      return "최근 결과는 추천 순서에만 반영됩니다.";
    },
  });
  assert.equal(calls, 1);
  assert.equal(answer, "최근 결과는 추천 순서에만 반영됩니다.");
});

test("autonomously inspects status and logs before answering a failure question", async () => {
  const prompts = [];
  const calls = [];
  const decisions = [
    {
      action: "inspect", purpose: "서비스 상태 확인", answer: null,
      calls: [{ tool: "service_status", unit: "jobs-daily.service", domain: null, lines: null, since_minutes: null, query: null }],
    },
    {
      action: "inspect", purpose: "실패 로그 확인", answer: null,
      calls: [{ tool: "service_logs", unit: "jobs-daily.service", domain: null, lines: 80, since_minutes: 1440, query: null }],
    },
    { action: "answer", purpose: "근거 종합", answer: "채용 수집은 인증 만료로 실패했습니다.", calls: [] },
  ];
  const answer = await runReadOnlyDiagnosticAgent({
    question: "채용 수집이 왜 실패했지?",
    snapshot: fixtureSnapshot(),
    runner: async ({ prompt, schema }) => {
      prompts.push(prompt);
      assert.equal(schema, diagnosticDecisionSchema);
      return decisions.shift();
    },
    execute: async (call) => {
      calls.push(call.tool);
      return { tool: call.tool, args: { unit: call.unit }, output: call.tool === "service_logs" ? "authorization expired" : "Result=exit-code" };
    },
  });
  assert.deepEqual(calls, ["service_status", "service_logs"]);
  assert.match(prompts[1], /Result=exit-code/);
  assert.match(prompts[2], /authorization expired/);
  assert.equal(answer, "채용 수집은 인증 만료로 실패했습니다.");
});

test("retries the autonomous agent with the configured API fallback only for quota errors", async () => {
  const keys = [];
  const answer = await runReadOnlyDiagnosticAgent({
    question: "현재 구성 설명",
    snapshot: fixtureSnapshot(),
    env: { CODEX_API_FALLBACK_KEY: "test-api-key" },
    runner: async ({ apiKey }) => {
      keys.push(apiKey);
      if (!apiKey) throw new Error("usage limit reached");
      return { action: "answer", purpose: "설명", answer: "fallback 응답", calls: [] };
    },
  });
  assert.deepEqual(keys, [null, "test-api-key"]);
  assert.equal(answer, "fallback 응답");
});

test("routes a slash-job natural question through the manager module", async () => {
  const sent = [];
  const questions = [];
  const module = createManagerBotModule({
    snapshot: () => fixtureSnapshot(),
    answer: async (question) => {
      questions.push(question);
      return `질문: ${question}`;
    },
    send: async (message) => sent.push(message),
  });
  assert.equal(await module.handleMessage({ text: "/job 에서 우선순위 알려줘" }), true);
  assert.deepEqual(sent, ["질문: /job 에서 우선순위 알려줘"]);
  assert.equal(await module.handleMessage({ text: "왜 실패했지?" }), true);
  assert.match(questions[1], /이전 대화/);
  assert.match(questions[1], /현재 질문/);
  assert.equal(await module.handleMessage({ text: "오늘 점심 뭐 먹지?" }), false);
});

test("enforces the command and unit allowlists and redacts diagnostic output", async () => {
  let invoked = false;
  await assert.rejects(
    executeReadOnlyTool({ tool: "service_logs", unit: "ssh.service", lines: 999, since_minutes: 1, domain: null, query: null }, {
      command: async () => { invoked = true; return "should not run"; },
    }),
    /allowlist/,
  );
  assert.equal(invoked, false);

  let commandArgs;
  const result = await executeReadOnlyTool({
    tool: "service_logs", unit: "jobs-daily.service", lines: 999, since_minutes: 1, domain: null, query: null,
  }, {
    command: async (file, args) => {
      commandArgs = { file, args };
      return "token=secret-value Bearer abc.def";
    },
  });
  assert.equal(commandArgs.file, "/usr/bin/journalctl");
  assert.equal(commandArgs.args[commandArgs.args.indexOf("--lines") + 1], "200");
  assert.equal(commandArgs.args[commandArgs.args.indexOf("--since") + 1], "5 minutes ago");
  assert.doesNotMatch(result.output, /secret-value|abc\.def/);
  assert.match(result.output, /REDACTED/);
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
