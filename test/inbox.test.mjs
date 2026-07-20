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
const {
  createInboxItem, getInboxItem, inboxClassifierUsage, listInboxActionItems, listInboxItems,
} = await import("../src/apps/inbox/store.mjs");
const { isValidCalendarDate } = await import("../src/apps/reminders/service.mjs");
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

test("rejects impossible dates and accepts leap day", () => {
  assert.equal(classifyInboxByRules({ text: "2026-02-31 14:00 병원 예약" }).intent, "invalid_date");
  assert.equal(isValidCalendarDate("2026-02-29"), false);
  assert.equal(isValidCalendarDate("2028-02-29"), true);
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

test("keeps a grounded relative-date event returned with an explicit timezone", async () => {
  const result = await classifyInboxMessage({ text: "내일 오후 2시 병원" }, {
    modelRunner: async () => ({
      intent: "save", kind: "event", title: "병원", event_at: "2026-07-21T14:00:00+09:00",
      next_action: "병원 방문", url: null, assumptions: [],
    }),
  });
  assert.equal(result.eventAt, "2026-07-21T05:00:00.000Z");
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
  assert.match(sent[0], /^✅ 할 일 저장/);
  assert.equal(listInboxItems().length, 1);

  assert.equal(await module.handleMessage({
    message_id: 11, text: "이거 취소해", chat: { id: 1 },
    reply_to_message: { message_id: 200 },
  }), true);
  assert.match(sent[1], /^🗑️ 취소했어요/);
  assert.equal(listInboxItems().length, 0);
});

test("supports numbered list replies, paging, and bounded action ranking", async () => {
  for (let index = 1; index <= 9; index += 1) {
    createInboxItem({
      kind: "task", title: `생활 할 일 ${index}`, nextAction: `처리 ${index}`,
      classifier: "rules", sourceMessageId: 100 + index,
    });
  }
  createInboxItem({
    kind: "event", title: "오래된 일정", nextAction: "확인",
    eventAt: "2020-01-01T00:00:00.000Z", classifier: "rules", sourceMessageId: 200,
  });
  const sent = [];
  let lastContext = null;
  const module = createInboxBotModule({
    send: async (text, extra, delivery) => {
      sent.push({ text, extra });
      lastContext = delivery?.context || null;
      return { message_id: 300 + sent.length };
    },
  });
  await module.handleMessage({ message_id: 300, text: "/inbox", chat: { id: 1 } });
  assert.equal(lastContext.items.length, 8);
  assert.match(sent.at(-1).text, /1–8/);
  const firstContext = lastContext;

  await module.handleMessage({ message_id: 301, text: "2번 완료", chat: { id: 1 } }, firstContext);
  assert.equal(getInboxItem(firstContext.items[1].id).status, "completed");

  await module.handleMessage({ message_id: 302, text: "더 보여줘", chat: { id: 1 } }, firstContext);
  assert.ok(lastContext.offset >= 8);
  assert.ok(lastContext.items.length >= 1);
  const secondContext = lastContext;
  assert.equal(secondContext.items.some((item) => firstContext.seenIds.includes(item.id)), false);
  await module.handleMessage({ message_id: 303, text: "더 보여줘", chat: { id: 1 } }, secondContext);
  assert.match(sent.at(-1).text, /더 보여드릴 활성 항목이 없어요/);
  assert.equal(listInboxActionItems({ now: new Date("2026-07-20T00:00:00.000Z") }).some((item) => item.title === "오래된 일정"), false);
});

test("re-sends a stored attachment from a numbered list reply", async () => {
  const item = createInboxItem({
    kind: "reference", title: "계약서", nextAction: "검토",
    attachment: { type: "document", fileId: "telegram-file" },
    classifier: "rules", sourceMessageId: 400,
  });
  const calls = [];
  const module = createInboxBotModule({
    send: async () => ({ message_id: 1 }),
    telegramApi: async (method, payload) => calls.push({ method, payload }),
  });
  const context = { domain: "inbox", kind: "list", items: [{ index: 1, id: item.id, domain: "inbox", title: item.title }] };
  await module.handleMessage({ message_id: 401, text: "1번 보여줘", chat: { id: 1 } }, context);
  assert.equal(calls[0].method, "sendDocument");
  assert.equal(calls[0].payload.document, "telegram-file");
});

test("opens a stored link and asks once when a list target is ambiguous", async () => {
  const linked = createInboxItem({
    kind: "watch", title: "참고 링크", nextAction: "확인", sourceUrl: "https://example.test/item",
    classifier: "rules", sourceMessageId: 500,
  });
  const other = createInboxItem({
    kind: "task", title: "다른 항목", nextAction: "처리", classifier: "rules", sourceMessageId: 501,
  });
  const sent = [];
  const module = createInboxBotModule({ send: async (text) => sent.push(text) });
  const context = {
    domain: "inbox", kind: "list",
    items: [
      { index: 1, id: linked.id, domain: "inbox", title: linked.title },
      { index: 2, id: other.id, domain: "inbox", title: other.title },
    ],
  };
  await module.handleMessage({ message_id: 502, text: "1번 보여줘", chat: { id: 1 } }, context);
  assert.match(sent.at(-1), /https:\/\/example\.test\/item/);
  await module.handleMessage({ message_id: 503, text: "완료", chat: { id: 1 } }, context);
  assert.match(sent.at(-1), /어느 항목인지 번호/);
  assert.equal(getInboxItem(linked.id).status, "active");
  assert.equal(getInboxItem(other.id).status, "active");
  await module.handleMessage({ message_id: 504, text: "완료", chat: { id: 1 } });
  assert.match(sent.at(-1), /\/inbox 목록/);
});

test("proposes a timed reminder from an exact future Inbox event", async () => {
  const event = createInboxItem({
    kind: "event", title: "병원 예약", nextAction: "준비",
    eventAt: "2026-08-22T05:00:00.000Z", classifier: "rules", sourceMessageId: 600,
  });
  const proposals = [];
  const module = createInboxBotModule({
    send: async () => null,
    propose: async (value) => proposals.push(value),
  });
  await module.handleMessage({ message_id: 601, text: "알림도 등록해", chat: { id: 1 } }, {
    domain: "inbox", kind: "item", entityId: event.id,
  });
  assert.equal(proposals[0].dueAt, event.event_at);
  assert.equal(proposals[0].metadata.entityId, event.id);
});

test("rejects an impossible date correction without mutating the event", async () => {
  const event = createInboxItem({
    kind: "event", title: "진료", nextAction: "방문",
    eventAt: "2026-08-22T05:00:00.000Z", classifier: "rules", sourceMessageId: 700,
  });
  const sent = [];
  const module = createInboxBotModule({ send: async (text) => sent.push(text) });
  await module.handleMessage({ message_id: 701, text: "2026-02-31 14:00로 변경", chat: { id: 1 } }, {
    domain: "inbox", kind: "item", entityId: event.id,
  });
  assert.match(sent[0], /존재하지 않는 날짜/);
  assert.equal(getInboxItem(event.id).event_at, "2026-08-22T05:00:00.000Z");
});
