import {
  getNotice,
  housingApplicationStatus,
  applicationResult,
  applicationResultCheck,
  disableHousingRule,
  listHousingRules,
  noticesForDigest,
  noticeForMessage,
  saveTelegramMessage,
  saveApplicationResult,
  setHousingRecommendationFeedback,
  setAnnouncementDate,
  setApplication,
} from "../../db.mjs";
import { sendMessage, telegram } from "../../telegram.mjs";
import { sendStatus } from "../../report.mjs";
import { HOUSING_BASE_INSTRUCTION, parseRuleCommand } from "./instructions.mjs";
import { parseHousingResultFeedback } from "./result-feedback.mjs";
import {
  proposeExplicitRule,
  ruleProposalKeyboard,
  ruleProposalMessage,
  parseEntityFeedback,
  saveEntityFeedback,
} from "../feedback/service.mjs";
import { recordFeedbackEvent } from "../../core/state.mjs";
import { telegramMessageContext } from "../../core/state.mjs";
import { formatUndoResult, undoFeedbackPattern, undoLatestFeedback } from "../feedback/undo.mjs";
import { proposeHousingApplicationFollowup } from "./application-followup.mjs";
import { feedbackTargetQuestion, resolveFeedbackTarget } from "../feedback/reference.mjs";

const datePattern = /(20\d{2})[.\/-](\d{1,2})[.\/-](\d{1,2})/;

function normalizedDate(text) {
  const match = text.match(datePattern);
  return match ? `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}` : null;
}

function callbackParts(data) {
  const parts = String(data || "").split(":");
  return parts[0] === "h" ? [parts[1], parts[2]] : [parts[0], parts[1]];
}

async function sendApplicationConfirmation(notice, intro) {
  const reminder = await proposeHousingApplicationFollowup(notice, { intro });
  if (reminder) return;
  const confirmation = await sendMessage(
    `${intro}\n\n발표 일정을 공고에서 찾지 못했습니다. 날짜를 알게 되면 이 메시지에 “2026-08-10 발표”처럼 답장해 주세요.`,
    {},
    { context: { domain: "housing", kind: "item", entityId: notice.id } },
  );
  if (confirmation?.message_id) saveTelegramMessage(confirmation.message_id, notice.id);
}

export const housingBotModule = {
  id: "housing",
  help: "🏠 주거 공고\n/housing_status : 지원 및 결과 현황\n/housing_guide : 공고 분석 기본 지침\n/housing_rules : 추가·제외 지침 목록\n브리핑에 답장: ‘3번 넣었어’, ‘3번 2026-08-10 발표’\n결과 알림에 답장: ‘미선정, 컷라인 2순위 7점, 50호 공급’\n지침 예: ‘민간임대는 앞으로 제외해’",
  commands: [
    { command: "housing_status", description: "🏠 지원 중인 주택 공고" },
    { command: "housing_guide", description: "🏠 공고 분석 기본 지침" },
    { command: "housing_rules", description: "🏠 추가·제외 지침 목록" },
  ],

  canHandleCallback(query) {
    const data = String(query.data || "");
    return data.startsWith("h:") || /^(ap|ig):/.test(data);
  },

  async handleCallback(query) {
    const [action, id] = callbackParts(query.data);
    const notice = getNotice(id);
    if (!notice) {
      await telegram("answerCallbackQuery", { callback_query_id: query.id, text: "공고를 찾지 못했습니다." });
      return;
    }
    if (action === "ap") {
      const previousApplicationStatus = housingApplicationStatus(id);
      setApplication(id, "applied");
      recordFeedbackEvent({
        domain: "housing", entityId: id, signal: "applied", rawText: "telegram callback",
        metadata: { title: notice.title, source: notice.source, previousApplicationStatus },
      });
      await telegram("answerCallbackQuery", { callback_query_id: query.id, text: "지원 상태로 저장했습니다." });
      await sendApplicationConfirmation(notice, `✅ 지원 진행 중으로 저장했습니다.\n[${notice.source}] ${notice.title}`);
    } else if (action === "ig") {
      const previousApplicationStatus = housingApplicationStatus(id);
      setApplication(id, "ignored");
      recordFeedbackEvent({
        domain: "housing", entityId: id, signal: "ignored", rawText: "telegram callback",
        metadata: { title: notice.title, source: notice.source, previousApplicationStatus },
      });
      await telegram("answerCallbackQuery", { callback_query_id: query.id, text: "관심 없음으로 저장했습니다." });
    } else if (["rs", "rn"].includes(action)) {
      const outcome = action === "rs" ? "selected" : "not_selected";
      const check = applicationResultCheck(id);
      saveApplicationResult(id, {
        stage: "document", outcome, source: "telegram",
        officialUrl: check?.official_url || null,
      });
      await telegram("answerCallbackQuery", {
        callback_query_id: query.id,
        text: outcome === "selected" ? "서류심사 선정으로 저장했습니다." : "서류심사 미선정으로 저장했습니다.",
      });
      const confirmation = await sendMessage(
        `${outcome === "selected" ? "✅ 서류심사 선정" : "❌ 서류심사 미선정"}으로 기록했습니다.\n${notice.title}\n\n컷라인·지원 주택·공급호수를 알면 이 메시지에 답장해 주세요. 다음 추천에 반영합니다.`,
      );
      saveTelegramMessage(confirmation.message_id, notice.id);
    }
  },

  async handleMessage(message) {
    const text = String(message.text || "").trim();
    const replyMessageId = message.reply_to_message?.message_id;
    if (/^\/(?:housing_guide|housing_instructions|instructions)(?:@\w+)?$/i.test(text) || /^기본\s*지침\s*(?:보여줘)?$/i.test(text)) {
      await sendMessage(`🏠 주거 봇 기본 지침\n\n${HOUSING_BASE_INSTRUCTION}`);
      return true;
    }
    if (/^\/(?:housing_rules|rules)(?:@\w+)?$/i.test(text) || /^(?:추가\s*)?지침\s*(?:목록|보여줘)$/i.test(text)) {
      const rules = listHousingRules();
      await sendMessage(rules.length
        ? `🏠 적용 중인 추가 지침\n\n${rules.map((rule) => `${rule.id}. ${rule.instruction}`).join("\n")}`
        : "현재 적용 중인 추가 지침이 없습니다.");
      return true;
    }
    const rule = replyMessageId ? null : parseRuleCommand(text);
    if (rule?.action === "delete") {
      const deleted = disableHousingRule(rule.id);
      await sendMessage(deleted ? `🗑️ ${rule.id}번 지침을 삭제했습니다.` : `활성 상태인 ${rule.id}번 지침을 찾지 못했습니다.`);
      return true;
    }
    if (rule?.action === "add") {
      const existing = listHousingRules().find((item) => item.kind === rule.kind && item.keyword === rule.keyword);
      if (existing) {
        await sendMessage(`이미 적용 중인 지침입니다: ${existing.instruction}`);
        return true;
      }
      const proposal = proposeExplicitRule({
        domain: "housing",
        kind: rule.kind,
        keyword: rule.keyword,
        instruction: rule.text,
      });
      await sendMessage(ruleProposalMessage(proposal, "다음 주택 수집부터 해당 키워드 공고 제외"), {
        reply_markup: ruleProposalKeyboard(proposal),
      });
      return true;
    }
    if (/^\/(?:housing_)?status(?:@\w+)?$/i.test(text) || /^(?:진행중|지원현황|뭐 넣었어)\s*$/i.test(text)) {
      await sendStatus();
      return true;
    }

    if (!replyMessageId) return false;
    const deliveryContext = telegramMessageContext(replyMessageId);
    const candidates = noticesForDigest(replyMessageId).map((notice) => ({ ...notice, index: notice.item_no }));
    const directNotice = noticeForMessage(replyMessageId);
    if (directNotice) candidates.push({ ...directNotice, index: 1 });
    if (deliveryContext?.domain === "housing" && deliveryContext?.kind === "digest") {
      for (const item of deliveryContext.items || []) {
        if (candidates.some((candidate) => candidate.id === item.id)) continue;
        const notice = getNotice(item.id);
        if (notice) candidates.push({ ...notice, index: item.index });
      }
    }
    if (deliveryContext?.domain === "housing" && deliveryContext?.kind === "item" && deliveryContext.entityId) {
      const notice = getNotice(deliveryContext.entityId);
      if (notice && !candidates.some((candidate) => candidate.id === notice.id)) candidates.push({ ...notice, index: 1 });
    }
    if (!candidates.length) return false;
    const resolution = resolveFeedbackTarget(text, candidates);
    const replied = resolution.item;
    if (!replied) {
      await sendMessage(feedbackTargetQuestion(candidates, resolution));
      return true;
    }

    if (undoFeedbackPattern.test(text)) {
      await sendMessage(formatUndoResult(undoLatestFeedback({ domain: "housing", entityId: replied.id, text })));
      return true;
    }

    const feedback = parseHousingResultFeedback(text);
    const previousResult = applicationResult(replied.id);
    if (feedback.outcome || previousResult) {
      const saved = saveApplicationResult(replied.id, {
        stage: "document",
        outcome: feedback.outcome || previousResult.outcome,
        housingName: feedback.housingName,
        cutoffPriority: feedback.cutoffPriority,
        cutoffScore: feedback.cutoffScore,
        supplyUnits: feedback.supplyUnits,
        reachedPriority: feedback.reachedPriority,
        note: feedback.note,
        source: "telegram",
      });
      if (feedback.preference) setHousingRecommendationFeedback(feedback.preference);
      await sendMessage([
        "📝 지원 결과 피드백을 저장했습니다.",
        saved.housing_name ? `지원 주택: ${saved.housing_name}` : null,
        saved.cutoff_priority ? `컷라인: ${saved.cutoff_priority}순위${saved.cutoff_score != null ? ` ${saved.cutoff_score}점` : ""}` : null,
        saved.supply_units ? `공급호수: ${saved.supply_units}호` : null,
        feedback.preference ? `다음 추천 기준: ${feedback.preference}` : null,
      ].filter(Boolean).join("\n"));
      return true;
    }

    const parsedEntityFeedback = parseEntityFeedback(text, { domain: "housing" });
    if (parsedEntityFeedback?.signal === "applied") {
      const previousApplicationStatus = housingApplicationStatus(replied.id);
      setApplication(replied.id, "applied");
      recordFeedbackEvent({
        domain: "housing", entityId: replied.id, signal: "applied", rawText: text,
        metadata: { title: replied.title, source: replied.source, previousApplicationStatus },
      });
      await sendApplicationConfirmation(replied, `✅ 지원 진행 중으로 저장했습니다: ${replied.title}`);
      return true;
    }
    const date = normalizedDate(text);
    if (date) {
      setAnnouncementDate(replied.id, date);
      const reminder = await proposeHousingApplicationFollowup(
        { ...replied, announcement_date: date },
        { announcementDate: date, intro: `📅 ${replied.title}\n발표일을 ${date}로 저장했습니다.` },
      );
      if (!reminder) await sendMessage(`📅 ${replied.title}\n발표일을 ${date}로 저장했습니다.`);
      return true;
    }
    const previousApplicationStatus = housingApplicationStatus(replied.id);
    const entityFeedback = saveEntityFeedback({
      domain: "housing",
      entityId: replied.id,
      text,
      title: replied.title,
      source: replied.source,
      metadata: { previousApplicationStatus },
    });
    if (entityFeedback) {
      if (entityFeedback.signal === "negative") {
        setApplication(replied.id, "ignored");
        await sendMessage(`알겠어요. 이 공고는 추천에서 제외했습니다: ${replied.title}`);
      } else {
        await sendMessage(`피드백을 저장했습니다: ${replied.title}`);
      }
      return true;
    }
    await sendMessage("주거 브리핑에는 공고 번호를 붙여 답장해 주세요. 예: ‘3번 넣었어’");
    return true;
  },
};
