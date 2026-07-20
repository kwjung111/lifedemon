import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "lifedemon-outbox-"));
process.env.MONITOR_DATA_DIR = dataDir;
process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.TELEGRAM_CHAT_ID = "1";

const { createTelegramClient } = await import("../src/telegram.mjs");
const {
  claimTelegramOutbox, completeTelegramOutbox, enqueueTelegramOutbox,
  platformDb, telegramMessageContext, telegramOutboxHealth,
} = await import("../src/core/state.mjs");

test.after(() => {
  platformDb.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function success(messageId) {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, result: { message_id: messageId, date: 1 } }),
  });
}

test("delivers a deduplicated outbox entry once and retains reply context", async () => {
  let calls = 0;
  const client = createTelegramClient({
    fetchImpl: async (...args) => { calls += 1; return success(41)(...args); },
    maxAttempts: 1,
  });
  const delivery = {
    dedupeKey: "test:digest:1",
    context: { domain: "jobs", kind: "digest", items: [{ index: 1, id: "job-1" }] },
  };
  const first = await client.sendMessage("테스트", {}, delivery);
  const second = await client.sendMessage("테스트", {}, delivery);
  assert.equal(first.message_id, 41);
  assert.equal(second.message_id, 41);
  assert.equal(calls, 1);
  assert.equal(telegramMessageContext(41).items[0].id, "job-1");
});

test("keeps network failures pending and delivers them after connectivity recovers", async () => {
  const failing = createTelegramClient({
    fetchImpl: async () => { throw new Error("network down"); },
    maxAttempts: 1,
  });
  await assert.rejects(() => failing.sendMessage("나중에 전송", {}, { dedupeKey: "test:recovery" }), /network down/);
  assert.equal(telegramOutboxHealth().counts.pending, 1);
  platformDb.prepare("UPDATE telegram_outbox SET available_at='2000-01-01T00:00:00.000Z' WHERE dedupe_key='test:recovery'").run();

  const recovered = createTelegramClient({ fetchImpl: success(42), maxAttempts: 1 });
  const result = await recovered.flushTelegramOutbox();
  assert.equal(result.delivered, 1);
  assert.equal(telegramOutboxHealth().counts.delivered, 2);
});

test("waits for a concurrently claimed row instead of reporting queued as delivered", async () => {
  const row = enqueueTelegramOutbox({
    method: "sendMessage", payload: { chat_id: "1", text: "경합" }, dedupeKey: "test:claimed",
  });
  claimTelegramOutbox({ id: row.id });
  let waits = 0;
  const client = createTelegramClient({
    fetchImpl: success(99), maxAttempts: 1, deliveryWaitMs: 2_000,
    sleep: async () => {
      waits += 1;
      if (waits === 1) completeTelegramOutbox(row.id, { message_id: 77, date: 1 });
    },
  });
  const result = await client.sendMessage("경합", {}, { dedupeKey: "test:claimed" });
  assert.equal(result.message_id, 77);
  assert.ok(waits >= 1);
});
