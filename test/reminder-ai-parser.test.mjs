import assert from "node:assert/strict";
import test from "node:test";

import {
  looksLikeReminderRequest,
  looksLikeReminderClarification,
  parseReminderRequest,
  runReminderModel,
} from "../src/apps/reminders/ai-parser.mjs";

test("uses the ChatGPT-linked Codex login first without exposing unrelated secrets", async () => {
  let request;
  const result = await runReminderModel("parse this reminder", {
    env: {
      OPENAI_API_KEY: "openai-secret",
      TELEGRAM_BOT_TOKEN: "telegram-secret",
      GOOGLE_OAUTH_REFRESH_TOKEN: "google-secret",
      MYHOME_API_SERVICE_KEY: "myhome-secret",
    },
    codexRunner: async (options) => {
      request = options;
      return {
        intent: "needs_clarification",
        title: null,
        due_at: null,
        url: null,
        clarification: "몇 시인가요?",
      };
    },
  });

  assert.equal(request.apiKey, null);
  assert.equal(request.search, false);
  assert.equal(request.schema.type, "object");
  assert.doesNotMatch(request.prompt, /telegram-secret|google-secret|myhome-secret|openai-secret/);
  assert.equal(result.clarification, "몇 시인가요?");
});

test("does not treat placeholder API keys as a fallback", async () => {
  let attempts = 0;
  await assert.rejects(() => runReminderModel("parse", {
    env: { OPENAI_API_KEY: "missing", CODEX_API_FALLBACK_KEY: "missing" },
    codexRunner: async () => {
      attempts += 1;
      throw new Error("authentication required");
    },
  }));
  assert.equal(attempts, 1);
});

test("retries reminder parsing with a valid API fallback key", async () => {
  const attempts = [];
  const result = await runReminderModel("parse", {
    env: { CODEX_API_FALLBACK_KEY: "valid-secret", CODEX_API_FALLBACK_ENABLED: "true" },
    codexRunner: async ({ apiKey }) => {
      attempts.push(apiKey);
      if (!apiKey) throw new Error("usage limit reached");
      return { intent: "not_reminder", title: null, due_at: null, url: null, clarification: null };
    },
  });
  assert.deepEqual(attempts, [null, "valid-secret"]);
  assert.equal(result.intent, "not_reminder");
});

test("only routes likely reminder intent to the AI parser", () => {
  assert.equal(looksLikeReminderRequest("내일 오후 3시에 병원 예약 알려줘"), true);
  assert.equal(looksLikeReminderRequest("/remind 다음 주 월요일 아침에 회의"), true);
  assert.equal(looksLikeReminderRequest("/housing"), false);
  assert.equal(looksLikeReminderRequest("오늘 주택 공고 뭐 있어?"), false);
  assert.equal(looksLikeReminderRequest("보험 갱신 챙겨"), false);
  assert.equal(looksLikeReminderRequest("여권 사본 위치 기억해줘"), false);
  assert.equal(looksLikeReminderClarification("내일 오후 4시"), true);
  assert.equal(looksLikeReminderClarification("새 문서 저장해줘"), false);
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
