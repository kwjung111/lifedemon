import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "life-manual-"));
const housingProfile = join(dataDir, "housing-profile.json");
const jobProfile = join(dataDir, "job-profile.json");
const companies = join(dataDir, "companies.json");
writeFileSync(housingProfile, JSON.stringify({ birthDate: "1990-01-01", householdSize: 1 }));
writeFileSync(jobProfile, JSON.stringify({ preferences: {}, companyFilters: {} }));
writeFileSync(companies, "[]");
process.env.MONITOR_DATA_DIR = dataDir;
process.env.HOUSING_DATA_DIR = dataDir;
process.env.JOB_DATA_DIR = dataDir;
process.env.HOUSING_USER_PROFILE_FILE = housingProfile;
process.env.JOB_USER_PROFILE_FILE = jobProfile;
process.env.JOB_COMPANY_VERIFICATION_FILE = companies;
process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.TELEGRAM_CHAT_ID = "1";

globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, result: {} }) });

const { BASIC_MANUAL, DETAILED_MANUAL, createManualBotModule } = await import("../src/apps/manual/bot-module.mjs");
const { telegramMenuCommands } = await import("../src/modules.mjs");
const { platformDb } = await import("../src/core/state.mjs");
const { db: housingDb } = await import("../src/db.mjs");
const { jobDb } = await import("../src/apps/jobs/db.mjs");

test.after(() => {
  platformDb.close(); housingDb.close(); jobDb.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test("exposes only seven primary Telegram menu commands", () => {
  assert.deepEqual(telegramMenuCommands().map((item) => item.command), [
    "help", "briefing", "inbox", "reminders", "housing_status", "job_status", "ask",
  ]);
});

test("provides one short manual and a separate detailed view", async () => {
  const sent = [];
  const module = createManualBotModule({ send: async (text) => sent.push(text) });
  assert.equal(await module.handleMessage({ text: "/help" }), true);
  assert.equal(sent[0], BASIC_MANUAL);
  assert.match(sent[0], /그냥 보내세요/);
  assert.match(sent[0], /정시 알림/);
  assert.match(sent[0], /말풍선의 답장|목록 말풍선에 답장/);
  assert.ok(sent[0].length < 1200);
  assert.equal(await module.handleMessage({ text: "/help 자세히" }), true);
  assert.equal(sent[1], DETAILED_MANUAL);
  assert.equal(sent.some((text) => /inline_keyboard/.test(text)), false);
});
