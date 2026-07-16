import assert from "node:assert/strict";
import test from "node:test";

import {
  looksLikeReminderRequest,
  parseReminderRequest,
  runReminderModel,
} from "../src/apps/reminders/ai-parser.mjs";

test("uses a tool-free structured request without exposing unrelated secrets", async () => {
  let request;
  const result = await runReminderModel("parse this reminder", {
    env: {
      OPENAI_API_KEY: "openai-secret",
      REMINDER_AI_MODEL: "test-model",
      TELEGRAM_BOT_TOKEN: "telegram-secret",
      GOOGLE_OAUTH_REFRESH_TOKEN: "google-secret",
      MYHOME_API_SERVICE_KEY: "myhome-secret",
    },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({
        output: [{
          type: "message",
          content: [{
            type: "output_text",
            text: JSON.stringify({
              intent: "needs_clarification",
              title: null,
              due_at: null,
              url: null,
              clarification: "몇 시인가요?",
            }),
          }],
        }],
      }), { status: 200 });
    },
  });

  const body = JSON.parse(request.options.body);
  assert.equal(request.url, "https://api.openai.com/v1/responses");
  assert.equal(request.options.headers.authorization, "Bearer openai-secret");
  assert.deepEqual(body.tools, []);
  assert.equal(body.store, false);
  assert.equal(body.text.format.type, "json_schema");
  assert.equal(body.text.format.strict, true);
  assert.doesNotMatch(request.options.body, /telegram-secret|google-secret|myhome-secret|openai-secret/);
  assert.equal(result.clarification, "몇 시인가요?");
});

test("only routes likely reminder intent to the AI parser", () => {
  assert.equal(looksLikeReminderRequest("내일 오후 3시에 병원 예약 알려줘"), true);
  assert.equal(looksLikeReminderRequest("/remind 다음 주 월요일 아침에 회의"), true);
  assert.equal(looksLikeReminderRequest("/housing"), false);
  assert.equal(looksLikeReminderRequest("오늘 주택 공고 뭐 있어?"), false);
});

test("normalizes an AI-parsed reminder", async () => {
  const now = new Date("2026-07-16T01:00:00.000Z");
  const result = await parseReminderRequest("내일 오후 3시에 병원 예약 알려줘", {
    now,
    modelRunner: async (prompt) => {
      assert.match(prompt, /2026-07-16 10:00:00/);
      return {
        intent: "reminder",
        title: "병원 예약",
        due_at: "2026-07-17T15:00:00+09:00",
        url: "https://example.test/hospital",
      };
    },
  });
  assert.deepEqual(result, {
    intent: "reminder",
    title: "병원 예약",
    dueAt: "2026-07-17T06:00:00.000Z",
    url: "https://example.test/hospital",
  });
});

test("asks for clarification instead of inventing missing time", async () => {
  const result = await parseReminderRequest("내일 병원 예약 알려줘", {
    modelRunner: async () => ({
      intent: "needs_clarification",
      title: null,
      due_at: null,
      clarification: "내일 몇 시에 알려드릴까요?",
    }),
  });
  assert.deepEqual(result, {
    intent: "needs_clarification",
    clarification: "내일 몇 시에 알려드릴까요?",
  });
});

test("rejects a past time returned by the model", async () => {
  const result = await parseReminderRequest("어제 일정 알려줘", {
    now: new Date("2026-07-16T01:00:00.000Z"),
    modelRunner: async () => ({
      intent: "reminder",
      title: "지난 일정",
      due_at: "2026-07-15T10:00:00+09:00",
      url: null,
    }),
  });
  assert.equal(result.intent, "needs_clarification");
  assert.match(result.clarification, /지난 시각/);
});

test("rejects a model timestamp with no explicit timezone", async () => {
  const result = await parseReminderRequest("내일 오후 3시에 알려줘", {
    now: new Date("2026-07-16T01:00:00.000Z"),
    modelRunner: async () => ({
      intent: "reminder",
      title: "일정",
      due_at: "2026-07-17T15:00:00",
      url: null,
    }),
  });
  assert.equal(result.intent, "needs_clarification");
});
