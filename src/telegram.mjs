import { createHash, randomUUID } from "node:crypto";
import dns from "node:dns";
import { setDefaultAutoSelectFamily } from "node:net";
import {
  claimTelegramOutbox,
  completeTelegramOutbox,
  enqueueTelegramOutbox,
  failTelegramOutbox,
  getTelegramOutbox,
  rescheduleTelegramOutbox,
} from "./core/state.mjs";

dns.setDefaultResultOrder("ipv4first");
try { setDefaultAutoSelectFamily(false); } catch { /* Node versions without the runtime switch use the systemd flag. */ }

const defaultToken = process.env.TELEGRAM_BOT_TOKEN;
export const chatId = String(process.env.TELEGRAM_CHAT_ID || "");

if (!defaultToken) throw new Error("TELEGRAM_BOT_TOKEN is required");
if (!chatId) throw new Error("TELEGRAM_CHAT_ID is required");

export class TelegramApiError extends Error {
  constructor(message, { retryable = true, status = null } = {}) {
    super(message);
    this.name = "TelegramApiError";
    this.retryable = retryable;
    this.status = status;
  }
}

export class TelegramDeliveryPendingError extends Error {
  constructor(message, outboxId) {
    super(message);
    this.name = "TelegramDeliveryPendingError";
    this.outboxId = outboxId;
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const parsedResult = (row) => {
  try { return JSON.parse(row?.result_json || "null"); } catch { return null; }
};

function automaticDedupeKey(method, payload) {
  const hash = createHash("sha256").update(JSON.stringify({ method, payload })).digest("hex").slice(0, 24);
  return `auto:${hash}:${randomUUID()}`;
}

function retryDelay(attempts) {
  return Math.min(6 * 60 * 60_000, 30_000 * (2 ** Math.min(10, Math.max(0, attempts - 1))));
}

export function createTelegramClient({
  token = defaultToken,
  allowedChatId = chatId,
  fetchImpl = globalThis.fetch,
  sleep = wait,
  maxAttempts = 4,
  retryBaseMs = 2_000,
  deliveryWaitMs = 50_000,
} = {}) {
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required");
  if (!allowedChatId) throw new Error("TELEGRAM_CHAT_ID is required");

  async function call(method, payload = {}) {
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(45_000),
        });
        const result = await response.json().catch(() => null);
        if (response.ok && result?.ok) return result.result;
        const retryable = response.status >= 500 || response.status === 429;
        throw new TelegramApiError(
          `${method} failed: ${result?.description || `HTTP ${response.status}`}`,
          { retryable, status: response.status },
        );
      } catch (error) {
        lastError = error;
        if (error instanceof TelegramApiError && !error.retryable) throw error;
      }
      if (attempt < maxAttempts) await sleep(attempt * retryBaseMs);
    }
    throw lastError;
  }

  async function deliverClaimed(row) {
    try {
      const result = await call(row.method, JSON.parse(row.payload_json));
      completeTelegramOutbox(row.id, result);
      return result;
    } catch (error) {
      if (error instanceof TelegramApiError && !error.retryable) failTelegramOutbox(row.id, error.message);
      else rescheduleTelegramOutbox(row.id, error.message, retryDelay(row.attempts));
      throw error;
    }
  }

  async function send(text, extra = {}, delivery = {}) {
    const payload = {
      chat_id: allowedChatId,
      text,
      disable_web_page_preview: true,
      ...extra,
    };
    const row = enqueueTelegramOutbox({
      method: "sendMessage",
      payload,
      dedupeKey: delivery.dedupeKey || automaticDedupeKey("sendMessage", payload),
      context: delivery.context || null,
    });
    if (row.status === "delivered") return parsedResult(row);
    if (row.status === "failed") throw new TelegramApiError(row.last_error || "Telegram message permanently failed", { retryable: false });
    const claimed = claimTelegramOutbox({ id: row.id });
    if (!claimed) {
      const deadline = Date.now() + deliveryWaitMs;
      while (Date.now() < deadline) {
        const current = getTelegramOutbox(row.id);
        if (current?.status === "delivered") return parsedResult(current);
        if (current?.status === "failed") {
          throw new TelegramApiError(current.last_error || "Telegram message permanently failed", { retryable: false });
        }
        const retryClaim = claimTelegramOutbox({ id: row.id });
        if (retryClaim) return deliverClaimed(retryClaim);
        await sleep(250);
      }
      throw new TelegramDeliveryPendingError(`Telegram delivery is still pending for outbox ${row.id}`, row.id);
    }
    return deliverClaimed(claimed);
  }

  async function flush({ limit = 20 } = {}) {
    const summary = { delivered: 0, rescheduled: 0, failed: 0 };
    for (let index = 0; index < limit; index += 1) {
      const claimed = claimTelegramOutbox();
      if (!claimed) break;
      try {
        await deliverClaimed(claimed);
        summary.delivered += 1;
      } catch (error) {
        if (error instanceof TelegramApiError && !error.retryable) summary.failed += 1;
        else summary.rescheduled += 1;
      }
    }
    return summary;
  }

  return { telegram: call, sendMessage: send, flushTelegramOutbox: flush };
}

const defaultClient = createTelegramClient();
export const telegram = defaultClient.telegram;
export const sendMessage = defaultClient.sendMessage;
export const flushTelegramOutbox = defaultClient.flushTelegramOutbox;
