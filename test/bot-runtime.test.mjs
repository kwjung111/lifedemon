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
  await bot.handleMessage({ message_id: 10, chat: { id: 1 }, text: "1번 괜찮네" });
  assert.match(sent[0], /말풍선을 왼쪽으로 밀어/);
  assert.equal(logs[0][1].replyToMessageId, null);
  assert.equal(logs[0][1].itemNumber, 1);
});

test("distinguishes a reply to an unknown Telegram message", async () => {
  const { bot, sent } = runtime();
  await bot.handleMessage({
    message_id: 11, chat: { id: 1 }, text: "1번 괜찮네",
    reply_to_message: { message_id: 999 },
  });
  assert.match(sent[0], /저장된 공고 브리핑과 연결되지 않았습니다/);
});

test("logs only routing metadata and the handling module", async () => {
  const { bot, sent, logs } = runtime({ handled: true });
  await bot.handleMessage({
    message_id: 12, chat: { id: 1 }, text: "민감한 원문",
    reply_to_message: { message_id: 215 },
  });
  assert.equal(sent.length, 0);
  assert.deepEqual(logs[0][1], {
    messageId: 12, replyToMessageId: 215, itemNumber: null, module: "test",
  });
  assert.doesNotMatch(JSON.stringify(logs), /민감한 원문/);
});
