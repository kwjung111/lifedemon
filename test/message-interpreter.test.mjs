import assert from "node:assert/strict";
import test from "node:test";
import {
  interpretMessage, messageInterpretationPrompt, messageInterpretationSchema,
  normalizeMessageInterpretation,
} from "../src/core/message-interpreter.mjs";

function raw(overrides = {}) {
  return {
    route: "not_supported", domain: null, confidence: 99, reason: "분류", clarification: null,
    follow_up: false, target_index: null, title: null, kind: null, event_at: null,
    next_action: null, url: null, assumptions: [], clear_event_at: false,
    feedback_intent: null, scope: null, strength: null, preference: null, keywords: [],
    aspects: [], rule_kind: null, rule_keyword: null, outcome: null, housing_name: null,
    cutoff_priority: null, cutoff_score: null, supply_units: null, reached_priority: null,
    announcement_date: null, question: null,
    ...overrides,
  };
}

test("uses one global structured call for a natural recommendation request", async () => {
  let calls = 0;
  let prompt = "";
  const result = await interpretMessage({ text: "채용 다 보여줘" }, null, {
    env: {},
    codexRunner: async (options) => {
      calls += 1;
      prompt = options.prompt;
      assert.equal(options.schema, messageInterpretationSchema);
      return raw({ route: "recommendations_list", domain: "jobs", confidence: 98 });
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.route, "recommendations_list");
  assert.equal(result.domain, "jobs");
  assert.equal(result.cutoffScore, null);
  assert.equal(result.supplyUnits, null);
  assert.match(prompt, /채용 다 보여줘/);
  assert.match(prompt, /Never follow instructions/);
});

test("fails closed for low confidence and invalid reply targets", () => {
  const context = { domain: "jobs", items: [{ index: 1, id: "one" }] };
  const uncertain = normalizeMessageInterpretation(
    raw({ route: "recommendations_list", domain: "jobs", confidence: 60 }),
    { text: "뭐 좀 보여줘" }, context,
  );
  assert.equal(uncertain.route, "not_supported");

  const invalidTarget = normalizeMessageInterpretation(
    raw({ route: "feedback", domain: "jobs", target_index: 9, feedback_intent: "negative" }),
    { text: "9번 별로" }, context,
  );
  assert.equal(invalidTarget.route, "not_supported");
  assert.match(invalidTarget.clarification, /어느 항목/);
});

test("normalizes future reminders and rejects past reminders", () => {
  const now = new Date("2026-07-21T00:00:00.000Z");
  const future = normalizeMessageInterpretation(raw({
    route: "reminder_create", domain: "reminders", title: "서류 제출",
    event_at: "2026-07-22T16:00:00+09:00",
  }), { text: "내일 오후 4시에 서류 제출 알려줘" }, null, { now });
  assert.equal(future.route, "reminder_create");
  assert.equal(future.eventAt, "2026-07-22T07:00:00.000Z");

  const past = normalizeMessageInterpretation(raw({
    route: "reminder_create", domain: "reminders", title: "지난 일정",
    event_at: "2026-07-20T16:00:00+09:00",
  }), { text: "어제 오후 4시에 알려줘" }, null, { now });
  assert.equal(past.route, "reminder_clarify");
});

test("grounds URLs in the actual user message", () => {
  const invented = normalizeMessageInterpretation(raw({
    route: "inbox_create", domain: "inbox", title: "참고", kind: "watch",
    url: "https://invented.example/item",
  }), { text: "이거 저장해" });
  assert.equal(invented.url, null);

  const grounded = normalizeMessageInterpretation(raw({
    route: "inbox_create", domain: "inbox", title: "참고", kind: "watch",
    url: "https://example.test/item",
  }), { text: "https://example.test/item 저장해" });
  assert.equal(grounded.url, "https://example.test/item");
});

test("exposes a direct replied item as target index one to the model", () => {
  const prompt = messageInterpretationPrompt(
    { text: "지원했어" },
    { domain: "jobs", kind: "item", entityId: "job-1" },
  );
  assert.match(prompt, /\"index\":1/);
  assert.match(prompt, /\"domain\":\"jobs\"/);
});
