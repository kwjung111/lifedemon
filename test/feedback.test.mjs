import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "lifedemon-feedback-"));
const housingProfile = join(dataDir, "housing-profile.json");
writeFileSync(housingProfile, JSON.stringify({ householdSize: 1 }));
process.env.MONITOR_DATA_DIR = dataDir;
process.env.HOUSING_DATA_DIR = dataDir;
process.env.JOB_DATA_DIR = dataDir;
process.env.HOUSING_USER_PROFILE_FILE = housingProfile;
process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.TELEGRAM_CHAT_ID = "1";

const {
  addFeedbackRule,
  createFeedbackRuleProposal,
  getFeedbackRuleProposal,
  listFeedbackRules,
  platformDb,
  recentFeedbackEvents,
  recordFeedbackEvent,
} = await import("../src/core/state.mjs");
const {
  parseEntityFeedback,
  proposeExplicitRule,
  ruleProposalKeyboard,
  saveEntityFeedback,
} = await import("../src/apps/feedback/service.mjs");
const { createFeedbackBotModule } = await import("../src/apps/feedback/bot-module.mjs");
const { db: housingDb } = await import("../src/db.mjs");
const {
  jobApplicationStatus, jobDb, setJobApplication, upsertJobPosting,
} = await import("../src/apps/jobs/db.mjs");
const { undoLatestFeedback } = await import("../src/apps/feedback/undo.mjs");

test.after(() => {
  platformDb.close();
  housingDb.close();
  jobDb.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test("parses item feedback without treating silence as a negative signal", () => {
  assert.deepEqual(parseEntityFeedback("2번 괜찮네", { domain: "jobs", company: "좋은회사" }), {
    signal: "positive", durableRule: null,
  });
  assert.equal(parseEntityFeedback("2번 나중에 볼게", { domain: "jobs", company: "좋은회사" }), null);
  assert.equal(parseEntityFeedback("2번 별로야", { domain: "jobs", company: "좋은회사" }).signal, "negative");
  assert.equal(parseEntityFeedback("2번 관심 없어", { domain: "jobs", company: "좋은회사" }).signal, "negative");
  assert.equal(parseEntityFeedback("위시켓은 좀 미묘한데", { domain: "jobs", company: "위시켓" }).signal, "negative");
  assert.equal(parseEntityFeedback("두 번째가 제일 나아 보이네", { domain: "jobs", company: "좋은회사" }).signal, "positive");
  assert.equal(parseEntityFeedback("이건 지원해볼 만함", { domain: "jobs", company: "좋은회사" }).signal, "positive");
  assert.equal(parseEntityFeedback("이거 신청할게", { domain: "housing" }), null);
  assert.equal(parseEntityFeedback("이거 신청 완료", { domain: "housing" }).signal, "applied");
  assert.equal(parseEntityFeedback("회사는 좋은데 직무는 별로", { domain: "jobs", company: "좋은회사" }), null);
  assert.deepEqual(
    parseEntityFeedback("2번 이 회사는 앞으로 빼", { domain: "jobs", company: "제외회사" }).durableRule,
    { domain: "jobs", kind: "exclude_company", keyword: "제외회사", instruction: "제외회사 회사 제외" },
  );
  assert.equal(
    parseEntityFeedback("이 회사 다음부터 안 보여줘", { domain: "jobs", company: "제외회사" }).durableRule.keyword,
    "제외회사",
  );
});

test("stores feedback centrally and creates only one pending durable proposal", () => {
  const first = saveEntityFeedback({
    domain: "jobs", entityId: "job-1", text: "이 회사는 앞으로 빼",
    company: "제외회사", title: "SRE", source: "wanted",
  });
  const second = saveEntityFeedback({
    domain: "jobs", entityId: "job-2", text: "이 회사 계속 제외",
    company: "제외회사", title: "DevOps", source: "remember",
  });
  assert.equal(first.event.signal, "negative");
  assert.equal(first.proposal.id, second.proposal.id);
  assert.equal(recentFeedbackEvents().length, 2);
  assert.equal(ruleProposalKeyboard(first.proposal).inline_keyboard[0].length, 2);
});

test("stores large feedback metadata as valid JSON without truncating undo fields", () => {
  const event = recordFeedbackEvent({
    domain: "jobs", entityId: "large-metadata", signal: "mixed", rawText: "혼합 피드백",
    metadata: {
      previousApplicationStatus: "applied",
      interpretation: { preference: "가".repeat(4500), aspects: [] },
    },
  });
  const metadata = JSON.parse(event.metadata_json);
  assert.equal(metadata.previousApplicationStatus, "applied");
  assert.equal(metadata.interpretation.preference.length, 4500);
});

test("deduplicates a replayed Telegram feedback event by source key", () => {
  const first = recordFeedbackEvent({
    domain: "jobs", entityId: "replayed-job", signal: "positive",
    rawText: "좋아", sourceKey: "message:123",
  });
  const replay = recordFeedbackEvent({
    domain: "jobs", entityId: "replayed-job", signal: "positive",
    rawText: "좋아", sourceKey: "message:123",
  });
  assert.equal(replay.id, first.id);
  assert.equal(platformDb.prepare(`
    SELECT COUNT(*) AS count FROM feedback_events WHERE source_key='message:123'
  `).get().count, 1);
});

test("requires one approval before a durable rule becomes active", async () => {
  const proposal = createFeedbackRuleProposal({
    domain: "jobs", kind: "exclude_company", keyword: "승인회사", instruction: "승인회사 회사 제외",
  });
  const callbacks = [];
  const sent = [];
  const module = createFeedbackBotModule({
    apply: (value) => {
      const rule = addFeedbackRule(value);
      return `feedback:${rule.id}`;
    },
    telegramApi: async (method, payload) => callbacks.push({ method, payload }),
    send: async (message) => sent.push(message),
  });
  assert.equal(module.canHandleCallback({ data: `f:ap:${proposal.id}` }), true);
  await module.handleCallback({ id: "callback-1", data: `f:ap:${proposal.id}` });
  assert.equal(getFeedbackRuleProposal(proposal.id).status, "approved");
  assert.equal(listFeedbackRules("jobs", "exclude_company")[0].keyword, "승인회사");
  assert.match(sent[0], /앞으로 적용/);
  assert.equal(callbacks[0].method, "answerCallbackQuery");

  const repeated = saveEntityFeedback({
    domain: "jobs", entityId: "job-repeat", text: "이 회사는 앞으로 빼",
    company: "승인회사", title: "반복 공고", source: "wanted",
  });
  assert.equal(repeated.alreadyActive, true);
  assert.equal(repeated.proposal, null);

  assert.equal(await module.handleMessage({ text: "피드백 규칙 보여줘" }), true);
  assert.match(sent.at(-1), new RegExp(`J${listFeedbackRules("jobs")[0].id}\\.`));
  const activeId = listFeedbackRules("jobs")[0].id;
  assert.equal(await module.handleMessage({ text: `J${activeId} 규칙 삭제` }), true);
  assert.equal(listFeedbackRules("jobs").length, 0);
});

test("explicit housing exclusions are proposals rather than immediate rules", () => {
  const proposal = proposeExplicitRule({
    domain: "housing", kind: "exclude_keyword", keyword: "민간임대", instruction: "민간임대 제외",
  });
  assert.equal(proposal.status, "proposed");
  assert.equal(listFeedbackRules("housing").length, 0);
});

test("undo restores application state and removes the feedback from active history", () => {
  const jobId = upsertJobPosting({
    source: "wanted", company: "되돌림회사", title: "SRE", url: "https://example.test/undo",
    rawText: "테스트 공고",
  });
  const previousApplicationStatus = jobApplicationStatus(jobId);
  const feedback = saveEntityFeedback({
    domain: "jobs", entityId: jobId, text: "1번 별로야",
    company: "되돌림회사", title: "SRE", source: "wanted",
    metadata: { previousApplicationStatus },
  });
  setJobApplication(jobId, "ignored");
  assert.equal(jobApplicationStatus(jobId), "ignored");

  const undone = undoLatestFeedback({ domain: "jobs", entityId: jobId, text: "방금 거 취소" });
  assert.equal(undone.event.id, feedback.event.id);
  assert.equal(jobApplicationStatus(jobId), null);
  assert.equal(recentFeedbackEvents().some((event) => event.id === feedback.event.id), false);
});

test("undo also disables a durable rule approved from that feedback", async () => {
  const jobId = upsertJobPosting({
    source: "wanted", company: "영구제외회사", title: "Platform Engineer", url: "https://example.test/rule-undo",
    rawText: "테스트 공고",
  });
  const feedback = saveEntityFeedback({
    domain: "jobs", entityId: jobId, text: "이 회사는 앞으로 빼",
    company: "영구제외회사", title: "Platform Engineer", source: "wanted",
    metadata: { previousApplicationStatus: null },
  });
  setJobApplication(jobId, "ignored");
  const module = createFeedbackBotModule({
    apply: (value) => {
      const rule = addFeedbackRule(value);
      return `feedback:${rule.id}`;
    },
    telegramApi: async () => null,
    send: async () => null,
  });
  await module.handleCallback({ id: "callback-rule-undo", data: `f:ap:${feedback.proposal.id}` });
  assert.equal(listFeedbackRules("jobs", "exclude_company").some((rule) => rule.keyword === "영구제외회사"), true);

  const undone = undoLatestFeedback({ domain: "jobs", entityId: jobId, text: "이 회사 제외한 거 취소" });
  assert.equal(undone.ruleDisabled, true);
  assert.equal(listFeedbackRules("jobs", "exclude_company").some((rule) => rule.keyword === "영구제외회사"), false);
  assert.equal(jobApplicationStatus(jobId), null);
});
