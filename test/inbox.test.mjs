import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "life-inbox-"));
process.env.MONITOR_DATA_DIR = dataDir;
process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.TELEGRAM_CHAT_ID = "1";

globalThis.fetch = async () => ({
  ok: true, status: 200,
  json: async () => ({ ok: true, result: { message_id: 100, date: 1 } }),
});

const { classifyInboxByRules, classifyInboxMessage } = await import("../src/apps/inbox/classifier.mjs");
const { createInboxBotModule } = await import("../src/apps/inbox/bot-module.mjs");
const { inboxClassifierUsage, listInboxItems } = await import("../src/apps/inbox/store.mjs");
const { platformDb } = await import("../src/core/state.mjs");

test.after(() => {
  platformDb.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test("classifies exact events without an AI call", async () => {
  const result = await classifyInboxMessage({ text: "2026-08-22 14:00 병원 예약" }, {
    modelRunner: async () => { throw new Error("AI should not run"); },
  });
  assert.equal(result.kind, "event");
  assert.equal(result.eventAt, "2026-08-22T05:00:00.000Z");
  assert.equal(inboxClassifierUsage().rule_calls, 1);
  assert.equal(inboxClassifierUsage().ai_calls, 0);
});

test("stores captionless documents as references", () => {
  const result = classifyInboxByRules({
    document: { file_id: "file-1", file_name: "contract.pdf", mime_type: "application/pdf" },
  });
  assert.equal(result.kind, "reference");
  assert.equal(result.title, "contract.pdf");
  assert.equal(result.nextAction, "첨부 내용 확인");
});

test("lets AI reject a conversational question instead of saving it", async () => {
  const result = await classifyInboxMessage({ text: "오늘 날씨 어때?" }, {
    modelRunner: async () => ({
      intent: "not_inbox", kind: "note", title: "", event_at: null,
      next_action: "", url: null, assumptions: [],
    }),
  });
  assert.equal(result.intent, "not_inbox");
  assert.equal(inboxClassifierUsage().ai_calls, 1);
});

test("saves once and accepts a natural reply to cancel", async () => {
  const sent = [];
  let context = null;
  const module = createInboxBotModule({
    send: async (text, _extra, delivery) => {
      sent.push(text);
      if (delivery?.context) context = delivery.context;
      return { message_id: 200 };
    },
    contextForMessage: (messageId) => messageId === 200 ? context : null,
    classify: async () => ({
      intent: "save", kind: "task", title: "보험 갱신", eventAt: null,
      nextAction: "보험사에 전화", url: null, assumptions: [], classifier: "rules",
    }),
  });

  assert.equal(await module.handleMessage({ message_id: 10, text: "보험 갱신해야", chat: { id: 1 } }), true);
  assert.match(sent[0], /^✅ 할 일로 저장했어요/);
  assert.equal(listInboxItems().length, 1);

  assert.equal(await module.handleMessage({
    message_id: 11, text: "이거 취소해", chat: { id: 1 },
    reply_to_message: { message_id: 200 },
  }), true);
  assert.match(sent[1], /^🗑️ 취소했어요/);
  assert.equal(listInboxItems().length, 0);
});
