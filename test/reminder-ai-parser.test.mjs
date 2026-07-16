import assert from "node:assert/strict";
import test from "node:test";

import {
  looksLikeReminderRequest,
  parseReminderRequest,
} from "../src/apps/reminders/ai-parser.mjs";

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
