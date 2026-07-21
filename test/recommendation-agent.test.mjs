import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "lifedemon-recommendation-agent-"));
const housingProfile = join(dataDir, "housing-profile.json");
writeFileSync(housingProfile, JSON.stringify({ householdSize: 1 }));
process.env.MONITOR_DATA_DIR = dataDir;
process.env.HOUSING_DATA_DIR = dataDir;
process.env.JOB_DATA_DIR = dataDir;
process.env.HOUSING_USER_PROFILE_FILE = housingProfile;
process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.TELEGRAM_CHAT_ID = "1";

const {
  jobApplicationStatus, jobDb, jobRecommendationHidden, setJobApplication, upsertJobPosting,
} = await import("../src/apps/jobs/db.mjs");
const {
  executeRecommendationAgentTool,
  recommendationAgentDecisionSchema,
  recommendationAgentItems,
  runRecommendationFeedbackAgent,
} = await import("../src/apps/feedback/agent.mjs");
const { createFeedbackBotModule } = await import("../src/apps/feedback/bot-module.mjs");
const { platformDb, recentFeedbackEvents } = await import("../src/core/state.mjs");
const { db: housingDb } = await import("../src/db.mjs");

const first = upsertJobPosting({
  source: "wanted", company: "첫회사", title: "상주 운영 담당",
  url: "https://example.test/agent-one", rawText: "고객사 상주 근무가 필요한 운영 공고",
});
const second = upsertJobPosting({
  source: "wanted", company: "둘회사", title: "클라우드 플랫폼 엔지니어",
  url: "https://example.test/agent-two", rawText: "클라우드 자동화와 플랫폼 운영",
});
const context = {
  domain: "jobs", kind: "digest",
  items: [
    { index: 1, id: first, domain: "jobs", title: "상주 운영 담당", company: "첫회사" },
    { index: 2, id: second, domain: "jobs", title: "클라우드 플랫폼 엔지니어", company: "둘회사" },
  ],
};

function call(tool, overrides = {}) {
  return {
    tool, domain: null, target_index: null, target_indexes: [], intent: null,
    scope: null, strength: null, preference: null, keywords: [], aspects: [],
    rule_kind: null, rule_keyword: null,
    ...overrides,
  };
}

test.after(() => {
  platformDb.close();
  jobDb.close();
  housingDb.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test("lets the model inspect and then execute several recommendation tools", async () => {
  let round = 0;
  const runner = async (options) => {
    assert.equal(options.schema, recommendationAgentDecisionSchema);
    round += 1;
    if (round === 1) return {
      action: "use_tools", reason: "상주 여부 상세 확인", answer: null, needs_clarification: false,
      calls: [call("inspect_items", { target_indexes: [1, 2] })],
    };
    if (round === 2) return {
      action: "use_tools", reason: "확인한 두 항목에 서로 다른 피드백 반영", answer: null, needs_clarification: false,
      calls: [
        call("record_feedback", {
          domain: "jobs", target_index: 1, intent: "negative", scope: "job_role", strength: "high",
          preference: "고객사 상주 업무는 선호하지 않음", keywords: ["상주"],
          aspects: [{ scope: "job_role", sentiment: "negative", keyword: "상주", reason: "명시적 비선호" }],
        }),
        call("record_feedback", {
          domain: "jobs", target_index: 2, intent: "positive", scope: "job_role", strength: "high",
          preference: "클라우드 플랫폼 업무를 선호함", keywords: ["클라우드 플랫폼"],
          aspects: [{ scope: "job_role", sentiment: "positive", keyword: "클라우드 플랫폼", reason: "명시적 선호" }],
        }),
      ],
    };
    return {
      action: "answer", reason: "작업 완료", answer: "첫 번째는 제외하고 두 번째 선호는 저장했어요.",
      needs_clarification: false, calls: [],
    };
  };
  const result = await runRecommendationFeedbackAgent({
    message: { message_id: 800, text: "상주하는 건 빼고 클라우드 플랫폼 쪽은 좋아", reply_to_message: { message_id: 1 } },
    context,
    runner,
  });
  assert.equal(round, 3);
  assert.match(result.answer, /첫 번째는 제외/);
  assert.equal(jobRecommendationHidden(first), true);
  assert.equal(jobRecommendationHidden(second), false);
  const signals = recentFeedbackEvents(10)
    .filter((event) => [first, second].includes(event.entity_id))
    .map((event) => event.signal);
  assert.deepEqual(new Set(signals), new Set(["negative", "positive"]));
  assert.equal(result.observations.filter((entry) => entry.output?.effect).length, 2);
});

test("rejects a mutation target outside the replied recommendation context", async () => {
  const items = recommendationAgentItems(context);
  const result = await executeRecommendationAgentTool(call("record_feedback", {
    domain: "jobs", target_index: 99, intent: "negative", scope: "item", strength: "high",
    preference: "없는 항목 제외",
  }), { items, text: "99번 제외", messageId: 801 });
  assert.equal(result.ok, false);
  assert.match(result.error, /대상을 찾지 못/);
});

test("does not repeat a mutation completed before a clarification reply", async () => {
  let executions = 0;
  let round = 0;
  const runner = async () => {
    round += 1;
    if (round === 1) return {
      action: "use_tools", reason: "이전 요청을 다시 시도", answer: null, needs_clarification: false,
      calls: [call("record_feedback", {
        domain: "jobs", target_index: 1, intent: "negative", scope: "item", strength: "high",
        preference: "첫 번째 제외",
      })],
    };
    return {
      action: "answer", reason: "중복 방지 확인", answer: "앞서 처리한 제외는 반복하지 않았어요.",
      needs_clarification: false, calls: [],
    };
  };
  const result = await runRecommendationFeedbackAgent({
    message: { message_id: 805, text: "두 번째 말한 거야" },
    context: {
      ...context,
      pendingFeedback: "첫 번째는 빼고 어느 클라우드 공고인지 물어봐",
      pendingAgentEffects: [{
        ok: true, effect: "recommendation_hidden", target_index: 1,
        target: "첫회사 — 상주 운영 담당", message: "추천 제외 · 첫회사 — 상주 운영 담당",
      }],
    },
    runner,
    execute: async () => { executions += 1; return { ok: true }; },
  });
  assert.equal(executions, 0);
  assert.match(result.answer, /반복하지 않았/);
});

test("keeps durable exclusions as approval proposals", async () => {
  const items = recommendationAgentItems(context);
  const result = await executeRecommendationAgentTool(call("record_feedback", {
    domain: "jobs", target_index: 1, intent: "durable_rule", scope: "company", strength: "high",
    preference: "첫회사는 앞으로 제외", keywords: ["첫회사"], rule_kind: "exclude_company",
  }), { items, text: "첫회사는 앞으로 빼", messageId: 802 });
  assert.equal(result.ok, true);
  assert.ok(result.proposal?.id);
  const proposal = platformDb.prepare("SELECT status FROM feedback_rule_proposals WHERE id=?").get(result.proposal.id);
  assert.equal(proposal.status, "proposed");
  const activeRule = platformDb.prepare("SELECT id FROM feedback_rules WHERE domain='jobs' AND keyword='첫회사' AND enabled=1").get();
  assert.equal(activeRule, undefined);
});

test("keeps application tracking while negative feedback hides only the recommendation", async () => {
  const id = upsertJobPosting({
    source: "wanted", company: "지원중회사", title: "백엔드 운영",
    url: "https://example.test/agent-applied", rawText: "지원 후 검토 중",
  });
  setJobApplication(id, "applied");
  const items = recommendationAgentItems({
    domain: "jobs", kind: "digest", items: [{ index: 1, id, domain: "jobs" }],
  });
  const result = await executeRecommendationAgentTool(call("record_feedback", {
    domain: "jobs", target_index: 1, intent: "negative", scope: "job_role", strength: "medium",
    preference: "직무는 선호하지 않지만 지원 추적은 유지", keywords: ["백엔드"],
  }), { items, text: "직무는 별로지만 지원은 유지해", messageId: 803 });
  assert.equal(result.ok, true);
  assert.equal(jobApplicationStatus(id), "applied");
  assert.equal(jobRecommendationHidden(id), true);
});

test("stores mixed aspects without hiding the recommendation", async () => {
  const id = upsertJobPosting({
    source: "wanted", company: "혼합회사", title: "Azure 아키텍트",
    url: "https://example.test/agent-mixed", rawText: "회사와 직무 평가가 다를 수 있음",
  });
  const items = recommendationAgentItems({
    domain: "jobs", kind: "digest", items: [{ index: 1, id, domain: "jobs" }],
  });
  const result = await executeRecommendationAgentTool(call("record_feedback", {
    domain: "jobs", target_index: 1, intent: "mixed", scope: "item", strength: "high",
    preference: "회사는 좋지만 직무는 비선호", keywords: ["혼합회사", "Azure"],
    aspects: [
      { scope: "company", sentiment: "positive", keyword: "혼합회사", reason: "회사 선호" },
      { scope: "job_role", sentiment: "negative", keyword: "Azure", reason: "직무 비선호" },
    ],
  }), { items, text: "회사는 좋은데 직무는 별로", messageId: 804 });
  assert.equal(result.ok, true);
  assert.equal(jobRecommendationHidden(id), false);
  const event = recentFeedbackEvents(20).find((entry) => entry.entity_id === id && entry.signal === "mixed");
  assert.equal(JSON.parse(event.metadata_json).interpretation.aspects.length, 2);
});

test("routes Telegram feedback through the agent and preserves proposal approval", async () => {
  const sent = [];
  const followups = [];
  const module = createFeedbackBotModule({
    send: async (...args) => { sent.push(args); return { message_id: 1 }; },
    runAgent: async () => ({
      answer: "두 요청을 처리했어요.",
      observations: [
        { output: { ok: true, effect: "recommendation_hidden", target: "첫회사 — 상주 운영 담당", proposal: { id: 7, keyword: "첫회사" } } },
        { output: { ok: true, effect: "application_tracked", followup: { title: "결과 발표", dueAt: "2026-08-01T00:00:00.000Z" } } },
      ],
    }),
    proposeFollowup: async (value) => { followups.push(value); },
  });
  const handled = await module.handleMessage({ text: "첫회사는 빼고 둘회사는 지원했어" }, {
    ...context,
    semantic: { route: "feedback", domain: "jobs" },
  });
  assert.equal(handled, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0][0], /두 요청을 처리했어요/);
  assert.match(sent[0][0], /실제 반영 결과/);
  assert.match(sent[0][1].reply_markup.inline_keyboard[0][0].text, /계속 제외/);
  assert.equal(followups.length, 1);
});
