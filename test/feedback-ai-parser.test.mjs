import assert from "node:assert/strict";
import test from "node:test";

import {
  feedbackPrompt,
  interpretFeedback,
  normalizeFeedbackInterpretation,
  runFeedbackModel,
} from "../src/apps/feedback/ai-parser.mjs";

const items = [
  { index: 1, company: "에이회사", title: "DevOps Engineer", location: "서울", raw_text: "SECRET BODY" },
  { index: 2, company: "비회사", title: "Platform Engineer", location: "서울" },
];

function result(overrides = {}) {
  return {
    intent: "mixed", target_index: 2, scope: "job_role", strength: "high",
    preference: "회사는 좋지만 플랫폼 직무는 선호하지 않음", keywords: ["플랫폼"],
    aspects: [
      { scope: "company", sentiment: "positive", keyword: "비회사", reason: "회사는 좋다고 표현" },
      { scope: "job_role", sentiment: "negative", keyword: "Platform", reason: "직무는 별로라고 표현" },
    ],
    rule_kind: "none", rule_keyword: null, confidence: 94,
    reason: "긍정과 부정이 함께 있는 피드백", clarification: null,
    ...overrides,
  };
}

test("uses linked Codex first and exposes only public digest fields", async () => {
  let request;
  await runFeedbackModel(feedbackPrompt("2번은 회사는 좋은데 직무가 별로", { domain: "jobs", items }), {
    env: { OPENAI_API_KEY: "api-secret", TELEGRAM_BOT_TOKEN: "telegram-secret" },
    codexRunner: async (options) => { request = options; return result(); },
  });
  assert.equal(request.apiKey, null);
  assert.equal(request.search, false);
  assert.doesNotMatch(request.prompt, /api-secret|telegram-secret|SECRET BODY/);
});

test("falls back to API only for linked-account quota or authentication errors", async () => {
  const attempts = [];
  await runFeedbackModel("prompt", {
    env: { CODEX_API_FALLBACK_KEY: "valid-key" },
    codexRunner: async ({ apiKey }) => {
      attempts.push(apiKey);
      if (!apiKey) throw new Error("usage limit reached");
      return result();
    },
  });
  assert.deepEqual(attempts, [null, "valid-key"]);

  let transientAttempts = 0;
  await assert.rejects(() => runFeedbackModel("prompt", {
    env: { CODEX_API_FALLBACK_KEY: "valid-key" },
    codexRunner: async () => { transientAttempts += 1; throw new Error("temporary network failure"); },
  }));
  assert.equal(transientAttempts, 1);
});

test("preserves mixed feedback as separately scored aspects", async () => {
  const parsed = await interpretFeedback("2번 회사는 좋은데 직무는 별로", { domain: "jobs", items }, {
    modelRunner: async () => result(),
  });
  assert.equal(parsed.intent, "mixed");
  assert.equal(parsed.targetIndex, 2);
  assert.deepEqual(parsed.aspects.map(({ scope, sentiment }) => [scope, sentiment]), [
    ["company", "positive"], ["job_role", "negative"],
  ]);
});

test("asks rather than acting on low confidence, unknown targets, or unsafe durable rules", () => {
  assert.equal(normalizeFeedbackInterpretation(result({ confidence: 60 }), items).intent, "clarify");
  assert.equal(normalizeFeedbackInterpretation(result({ target_index: 99 }), items).intent, "clarify");
  assert.equal(normalizeFeedbackInterpretation(result({
    intent: "durable_rule", confidence: 84, rule_kind: "exclude_company", rule_keyword: "비회사",
  }), items).intent, "clarify");
});
