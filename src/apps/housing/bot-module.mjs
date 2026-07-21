import {
  getNotice,
  housingApplicationStatus,
  housingRecommendationHidden,
  applicationResult,
  applicationResultCheck,
  listHousingRules,
  noticesForDigest,
  noticeForMessage,
  saveTelegramMessage,
  saveApplicationResult,
  setHousingRecommendationFeedback,
  setAnnouncementDate,
  setApplication,
  setHousingRecommendationHidden,
} from "../../db.mjs";
import { sendMessage, telegram } from "../../telegram.mjs";
import { sendStatus } from "../../report.mjs";
import { HOUSING_BASE_INSTRUCTION } from "./instructions.mjs";
import { recordFeedbackEvent } from "../../core/state.mjs";
import { telegramMessageContext } from "../../core/state.mjs";
import { formatUndoResult, undoLatestFeedback } from "../feedback/undo.mjs";
import { proposeHousingApplicationFollowup } from "./application-followup.mjs";

const datePattern = /(20\d{2})[.\/-](\d{1,2})[.\/-](\d{1,2})/;

function normalizedDate(text) {
  const match = text.match(datePattern);
  return match ? `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}` : null;
}

function callbackParts(data) {
  const parts = String(data || "").split(":");
  return parts[0] === "h" ? [parts[1], parts[2]] : [parts[0], parts[1]];
}

function commandName(text) {
  if (!text.startsWith("/")) return null;
  return text.slice(1).split(/\s/, 1)[0].split("@", 1)[0].toLowerCase();
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

export function createHousingBotModule() {
  return {
  id: "housing",
  help: "🏠 주거 공고\n/housing_status : 지원 및 결과 현황\n/housing_guide : 공고 분석 기본 지침\n/housing_rules : 추가·제외 지침 목록\n브리핑에 답장: ‘3번 넣었어’, ‘3번 2026-08-10 발표’\n결과 알림에 답장: ‘미선정, 컷라인 2순위 7점, 50호 공급’\n지침 예: ‘민간임대는 앞으로 제외해’",
  commands: [
    { command: "housing_status", description: "🏠 지원 중인 주택 공고" },
    { command: "housing_guide", description: "🏠 공고 분석 기본 지침" },
    { command: "housing_rules", description: "🏠 추가·제외 지침 목록" },
  ],

  canHandleMessage(_message, context) {
    const semantic = context?.semantic;
    return ["housing_status", "housing_guide"].includes(semantic?.route)
      || (["feedback_undo", "housing_result", "housing_announcement_date"].includes(semantic?.route)
        && semantic?.domain === "housing");
  },

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
        sourceKey: query.id ? `callback:${query.id}` : null,
        metadata: { title: notice.title, source: notice.source, previousApplicationStatus },
      });
      await telegram("answerCallbackQuery", { callback_query_id: query.id, text: "지원 상태로 저장했습니다." });
      await sendApplicationConfirmation(notice, `✅ 지원 진행 중으로 저장했습니다.\n[${notice.source}] ${notice.title}`);
    } else if (action === "ig") {
      const previousApplicationStatus = housingApplicationStatus(id);
      const previousRecommendationHidden = housingRecommendationHidden(id);
      setHousingRecommendationHidden(id, true);
      recordFeedbackEvent({
        domain: "housing", entityId: id, signal: "ignored", rawText: "telegram callback",
        sourceKey: query.id ? `callback:${query.id}` : null,
        metadata: { title: notice.title, source: notice.source, previousApplicationStatus, previousRecommendationHidden },
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

  async handleMessage(message, routedContext = null) {
    const text = String(message.text || "").trim();
    const replyMessageId = message.reply_to_message?.message_id;
    const semantic = routedContext?.semantic;
    if (["housing_guide", "housing_instructions", "instructions"].includes(commandName(text)) || semantic?.route === "housing_guide") {
      await sendMessage(`🏠 주거 봇 기본 지침\n\n${HOUSING_BASE_INSTRUCTION}`);
      return true;
    }
    if (["housing_rules", "rules"].includes(commandName(text))) {
      const rules = listHousingRules();
      await sendMessage(rules.length
        ? `🏠 적용 중인 추가 지침\n\n${rules.map((rule) => `${rule.id}. ${rule.instruction}`).join("\n")}`
        : "현재 적용 중인 추가 지침이 없습니다.");
      return true;
    }
    if (["housing_status", "status"].includes(commandName(text)) || semantic?.route === "housing_status") {
      await sendStatus();
      return true;
    }

    if (!replyMessageId) return false;
    const deliveryContext = routedContext || telegramMessageContext(replyMessageId);
    if (!["feedback_undo", "housing_result", "housing_announcement_date"].includes(semantic?.route)
      || semantic.domain !== "housing") return false;
    const feedbackText = message.briefingFeedbackText || (deliveryContext?.pendingFeedback
      ? `${deliveryContext.pendingFeedback}\n추가 답변: ${text}`
      : text);
    const candidates = message.briefingTarget?.domain === "housing"
      ? [{ ...message.briefingTarget, ...getNotice(message.briefingTarget.id), index: message.briefingTarget.index }]
      : noticesForDigest(replyMessageId).map((notice) => ({ ...notice, index: notice.item_no }));
    const directNotice = noticeForMessage(replyMessageId);
    if (directNotice) candidates.push({ ...directNotice, index: 1 });
    if (["housing", "briefing"].includes(deliveryContext?.domain)) {
      for (const item of deliveryContext.items || []) {
        if (item.domain && item.domain !== "housing") continue;
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
    const feedbackContext = {
      domain: "housing",
      kind: "digest",
      items: candidates.map((item) => ({
        index: item.index, id: item.id, domain: "housing",
        title: item.title, source: item.source,
      })),
    };
    const replied = semantic.targetIndex
      ? candidates.find((candidate) => Number(candidate.index) === semantic.targetIndex)
      : null;

    // Result facts, dates, and undo are state updates, not recommendation opinions.
    if (semantic.route === "feedback_undo") {
      await sendMessage(formatUndoResult(undoLatestFeedback({
        domain: "housing", entityId: replied?.id || null, text: feedbackText,
      })));
      return true;
    }
    if (semantic.route === "housing_result") {
      if (!replied) {
        await sendMessage("어느 공고의 결과인지 해당 공고 메시지에 답장해 주세요.", {}, { context: feedbackContext });
        return true;
      }
      const previousResult = applicationResult(replied.id);
      const saved = saveApplicationResult(replied.id, {
        stage: "document",
        outcome: semantic.outcome || previousResult?.outcome,
        housingName: semantic.housingName,
        cutoffPriority: semantic.cutoffPriority,
        cutoffScore: semantic.cutoffScore,
        supplyUnits: semantic.supplyUnits,
        reachedPriority: semantic.reachedPriority,
        note: semantic.reason,
        source: "telegram",
      });
      if (semantic.preference) setHousingRecommendationFeedback(semantic.preference);
      await sendMessage([
        "📝 지원 결과 피드백을 저장했습니다.",
        saved.housing_name ? `지원 주택: ${saved.housing_name}` : null,
        saved.cutoff_priority ? `컷라인: ${saved.cutoff_priority}순위${saved.cutoff_score != null ? ` ${saved.cutoff_score}점` : ""}` : null,
        saved.supply_units ? `공급호수: ${saved.supply_units}호` : null,
        semantic.preference ? `다음 추천 기준: ${semantic.preference}` : null,
      ].filter(Boolean).join("\n"));
      return true;
    }
    if (semantic.route === "housing_announcement_date") {
      const directDate = normalizedDate(semantic.announcementDate || "");
      if (!replied || !directDate) {
        await sendMessage("어느 공고의 발표일인지와 정확한 날짜를 다시 알려 주세요.", {}, { context: feedbackContext });
        return true;
      }
      setAnnouncementDate(replied.id, directDate);
      const reminder = await proposeHousingApplicationFollowup(
        { ...replied, announcement_date: directDate },
        { announcementDate: directDate, intro: `📅 ${replied.title}\n발표일을 ${directDate}로 저장했습니다.` },
      );
      if (!reminder) await sendMessage(`📅 ${replied.title}\n발표일을 ${directDate}로 저장했습니다.`);
      return true;
    }

    return false;
  },
  };
}

export const housingBotModule = createHousingBotModule();
