import assert from "node:assert/strict";
import test from "node:test";
import { createBotRuntime } from "../src/core/bot-runtime.mjs";

function runtime({ handled = false } = {}) {
  const sent = [];
  const logs = [];
  const bot = createBotRuntime({
    telegram: async () => [],
    sendMessage: async (text) => sent.push(text),
    allowedChatId: "1",
    modules: [{ id: "test", handleMessage: async () => handled }],
    loadOffset: () => 0,
    saveOffset: () => null,
    log: (...parts) => logs.push(parts),
  });
  return { bot, sent, logs };
}

test("explains when a numbered message was not sent with Telegram reply metadata", async () => {
  const { bot, sent, logs } = runtime();
  await bot.handleMessage({ message_id: 10, chat: { id: 1, type: "private" }, from: { id: 1 }, text: "1번 괜찮네" });
  assert.match(sent[0], /말풍선을 왼쪽으로 밀어/);
  assert.equal(logs[0][1].replyToMessageId, null);
  assert.equal(logs[0][1].itemNumber, 1);
});

test("distinguishes a reply to an unknown Telegram message", async () => {
  const { bot, sent } = runtime();
  await bot.handleMessage({
    message_id: 11, chat: { id: 1, type: "private" }, from: { id: 1 }, text: "1번 괜찮네",
    reply_to_message: { message_id: 999 },
  });
  assert.match(sent[0], /저장된 공고 브리핑과 연결되지 않았습니다/);
});

test("logs only routing metadata and the handling module", async () => {
  const { bot, sent, logs } = runtime({ handled: true });
  await bot.handleMessage({
    message_id: 12, chat: { id: 1, type: "private" }, from: { id: 1 }, text: "민감한 원문",
    reply_to_message: { message_id: 215 },
  });
  assert.equal(sent.length, 0);
  assert.deepEqual(logs[0][1], {
    messageId: 12, replyToMessageId: 215, itemNumber: null, module: "test",
  });
  assert.doesNotMatch(JSON.stringify(logs), /민감한 원문/);
});

test("requires both the private chat and authorized user", async () => {
  const { bot, sent } = runtime({ handled: true });
  await bot.handleMessage({ message_id: 13, chat: { id: 1, type: "group" }, from: { id: 1 }, text: "/help" });
  await bot.handleMessage({ message_id: 14, chat: { id: 1, type: "private" }, from: { id: 2 }, text: "/help" });
  assert.equal(sent.length, 0);
});

test("routes captionless attachments to modules", async () => {
  const { bot, sent, logs } = runtime({ handled: true });
  await bot.handleMessage({
    message_id: 15, chat: { id: 1, type: "private" }, from: { id: 1 },
    document: { file_id: "file-1", file_name: "note.pdf" },
  });
  assert.equal(sent.length, 0);
  assert.equal(logs[0][1].module, "test");
});

test("does not commit a failed update before processing succeeds", async () => {
  const transitions = [];
  let shouldFail = true;
  const bot = createBotRuntime({
    telegram: async () => [], sendMessage: async () => null,
    allowedChatId: "1", allowedUserId: "1",
    modules: [{ id: "test", handleMessage: async () => { if (shouldFail) throw new Error("boom"); return true; } }],
    loadOffset: () => 0, saveOffset: () => null,
    beginUpdate: () => ({ status: "processing", attempts: 1 }),
    completeUpdate: (id) => transitions.push(["done", id]),
    failUpdate: (id) => { transitions.push(["failed", id]); return { status: "pending" }; },
  });
  const update = { update_id: 99, message: { chat: { id: 1, type: "private" }, from: { id: 1 }, text: "test" } };
  await assert.rejects(() => bot.handleUpdate(update), /boom/);
  assert.deepEqual(transitions, [["failed", 99]]);
  shouldFail = false;
  await bot.handleUpdate(update);
  assert.deepEqual(transitions.at(-1), ["done", 99]);
});

test("routes reply context before broad keyword handlers", async () => {
  const routed = [];
  const bot = createBotRuntime({
    telegram: async () => [], sendMessage: async () => null,
    allowedChatId: "1", allowedUserId: "1",
    modules: [
      { id: "feedback", handleMessage: async () => { routed.push("feedback"); return true; } },
      {
        id: "inbox",
        canHandleMessage: (_message, context) => context?.domain === "inbox",
        handleMessage: async () => { routed.push("inbox"); return true; },
      },
    ],
    messageContext: () => ({ domain: "inbox", entityId: 7 }),
    loadOffset: () => 0, saveOffset: () => null,
  });
  await bot.handleMessage({
    message_id: 21, chat: { id: 1, type: "private" }, from: { id: 1 }, text: "방금 거 취소",
    reply_to_message: { message_id: 20 },
  });
  assert.deepEqual(routed, ["inbox"]);
});
