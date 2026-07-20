import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
const { askManagerConversation, buildConversationInput, compactRateLimits } = await import("../src/apps/manager/conversation.mjs");
const { executeReadOnlyTool, searchRepositorySource } = await import("../src/apps/manager/read-only-tools.mjs");
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

test("routes /ask through the persistent conversation while keeping other manager routes unchanged", async () => {
  const sent = [];
  const conversations = [];
  const diagnostics = [];
  const module = createManagerBotModule({
    snapshot: () => fixtureSnapshot(),
    converse: async (question) => {
      conversations.push(question);
      return "대화형 응답";
    },
    answer: async (question) => {
      diagnostics.push(question);
      return "진단 응답";
    },
    send: async (message) => sent.push(message),
  });
  assert.equal(await module.handleMessage({ text: "/ask 지금 사용량 얼마나 남았어?" }), true);
  assert.deepEqual(conversations, ["지금 사용량 얼마나 남았어?"]);
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(sent, ["대화형 응답"]);

  assert.equal(await module.handleMessage({ text: "/daemon" }), true);
  assert.equal(diagnostics.length, 1);
  assert.deepEqual(sent, ["대화형 응답", "진단 응답"]);
});

test("falls back to the bounded diagnostic agent when the conversational app-server fails", async () => {
  const sent = [];
  const module = createManagerBotModule({
    snapshot: () => fixtureSnapshot(),
    converse: async () => { throw new Error("app-server unavailable"); },
    answer: async () => "안전한 진단 fallback",
    send: async (message) => sent.push(message),
  });
  assert.equal(await module.handleMessage({ text: "/ask 서버 상태 알려줘" }), true);
  assert.deepEqual(sent, ["안전한 진단 fallback"]);
});

test("injects authoritative Codex rate limits into a conversational turn", async () => {
  const compact = compactRateLimits({
    rateLimits: {
      planType: "plus",
      primary: { usedPercent: 37, windowDurationMins: 300, resetsAt: 1_800_000_000 },
      secondary: { usedPercent: 61, windowDurationMins: 10_080, resetsAt: 1_800_500_000 },
    },
  });
  assert.equal(compact.primary.remainingPercent, 63);
  assert.equal(compact.secondary.remainingPercent, 39);

  const input = buildConversationInput("얼마나 남았어?", fixtureSnapshot(), { rateLimits: {
    planType: "plus",
    primary: { usedPercent: 37, windowDurationMins: 300, resetsAt: 1_800_000_000 },
  } });
  assert.match(input, /얼마나 남았어/);
  assert.match(input, /"remainingPercent":63/);
  assert.match(input, /trusted_runtime_context/);
});

test("persists and reuses the Codex conversation thread id", async () => {
  const calls = [];
  let saved = null;
  const client = {
    async attachThread(threadId) { calls.push(["attach", threadId]); return threadId || "thread-123"; },
    async rateLimits() { calls.push(["limits"]); return { rateLimits: { primary: { usedPercent: 10 } } }; },
    async runTurn(threadId, input) { calls.push(["turn", threadId, input]); return "현재 90% 남았습니다."; },
  };
  const answer = await askManagerConversation("사용량 알려줘", fixtureSnapshot(), {
    client,
    loadThreadId: () => saved,
    saveThreadId: (threadId) => { saved = threadId; },
  });
  assert.equal(answer, "현재 90% 남았습니다.");
  assert.equal(saved, "thread-123");
  assert.deepEqual(calls[0], ["attach", null]);

  await askManagerConversation("아까 거 다시", fixtureSnapshot(), {
    client,
    loadThreadId: () => saved,
    saveThreadId: (threadId) => { saved = threadId; },
  });
  assert.deepEqual(calls[3], ["attach", "thread-123"]);
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

  let searched;
  const searchResult = await executeReadOnlyTool({
    tool: "code_search", unit: null, lines: null, since_minutes: null, domain: null, query: "job_collection_last_success_at",
  }, {
    search: async (query) => {
      searched = query;
      return "src/apps/jobs/collect.mjs:21";
    },
  });
  assert.equal(searched, "job_collection_last_success_at");
  assert.match(searchResult.output, /collect\.mjs:21/);
});

test("searches only the bounded source tree without an external binary", async () => {
  const root = join(dataDir, "search-fixture");
  mkdirSync(join(root, "src", "apps"), { recursive: true });
  mkdirSync(join(root, "systemd"), { recursive: true });
  writeFileSync(join(root, "package.json"), "{}");
  writeFileSync(join(root, "src", "apps", "collect.mjs"), "const key = 'job_collection_last_success_at';\n");
  writeFileSync(join(root, "systemd", "jobs-daily.service"), "Description=fixture\n");
  const result = await searchRepositorySource("job_collection_last_success_at", root);
  assert.match(result, /src[\\/]apps[\\/]collect\.mjs:1/);
  assert.doesNotMatch(result, /job-profile/);
});

test("ranks multi-term source searches across paths and nearby identifier context", async () => {
  const root = join(dataDir, "ranked-search-fixture");
  mkdirSync(join(root, "src", "apps", "jobs"), { recursive: true });
  mkdirSync(join(root, "systemd"), { recursive: true });
  writeFileSync(join(root, "package.json"), "{}");
  writeFileSync(join(root, "src", "apps", "jobs", "collect.mjs"), [
    "const completedAt = new Date().toISOString();",
    "setJobSetting('job_collection_last_attempt_at', completedAt);",
    "setJobSetting('job_collection_last_success_at', completedAt);",
  ].join("\n"));
  writeFileSync(join(root, "src", "telemetry.mjs"), "const telemetry = true;\n");
  const result = await searchRepositorySource("jobs collection telemetry lastAttemptAt lastSuccessAt", root);
  assert.match(result.split("\n", 1)[0], /src[\\/]apps[\\/]jobs[\\/]collect\.mjs/);
  assert.match(result, /setJobSetting\('job_collection_last_success_at'/);
});

test("uses a fixed git invocation for bounded code history", async () => {
  let commandArgs;
  const result = await executeReadOnlyTool({
    tool: "code_history", unit: null, lines: null, since_minutes: null, domain: null, query: "job_collection_last_success_at",
  }, {
    command: async (file, args) => {
      commandArgs = { file, args };
      return "bcd95c8 2026-07-20T16:19:13+09:00 feat(ops): add collection health";
    },
  });
  assert.equal(commandArgs.file, "/usr/bin/git");
  assert.deepEqual(commandArgs.args.slice(-4), ["--", "package.json", "src", "systemd"]);
  assert.ok(commandArgs.args.includes("-Sjob_collection_last_success_at"));
  assert.match(result.output, /feat\(ops\)/);
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
