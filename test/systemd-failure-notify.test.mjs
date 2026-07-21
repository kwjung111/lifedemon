import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "lifedemon-failure-notify-"));
process.env.MONITOR_DATA_DIR = dataDir;
process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.TELEGRAM_CHAT_ID = "1";

const { buildFailureMessage, sanitizeFailureText } = await import("../src/admin/notify-systemd-failure.mjs");
const { platformDb } = await import("../src/core/state.mjs");

test.after(() => {
  platformDb.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test("redacts common credentials from systemd failure logs", () => {
  const text = sanitizeFailureText("token=secret-value Bearer abc.def bot123456:telegram-secret");
  assert.doesNotMatch(text, /secret-value|abc\.def|telegram-secret/);
  assert.match(text, /REDACTED/);
});

test("builds a bounded failure notification with service context", () => {
  const text = buildFailureMessage("housing-daily.service", {
    hostname: "daemon-host",
    status: "Result=exit-code\nExecMainStatus=1",
    logs: `failed ${"x".repeat(5000)}`,
  });
  assert.match(text, /housing-daily\.service/);
  assert.match(text, /daemon-host/);
  assert.ok(text.length <= 3900);
});
