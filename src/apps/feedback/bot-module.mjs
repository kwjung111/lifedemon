import { addHousingRule, disableHousingRule, listHousingRules } from "../../db.mjs";
import {
  addFeedbackRule,
  decideFeedbackRuleProposal,
  disableFeedbackRule,
  getFeedbackRuleProposal,
  listFeedbackRules,
  recentFeedbackEvents,
} from "../../core/state.mjs";
import { sendMessage, telegram } from "../../telegram.mjs";
import { formatUndoResult, undoFeedbackPattern, undoLatestFeedback } from "./undo.mjs";

function applyProposal(proposal) {
  if (proposal.domain === "housing" && proposal.kind === "exclude_keyword") {
    const rule = addHousingRule({
      kind: proposal.kind,
      keyword: proposal.keyword,
      text: proposal.instruction,
    });
    return `housing:${rule.id}`;
  }
  if (proposal.domain === "jobs" && proposal.kind === "exclude_company") {
    const rule = addFeedbackRule(proposal);
    return `feedback:${rule.id}`;
  }
  throw new Error("지원하지 않는 피드백 규칙입니다.");
}

export function createFeedbackBotModule({
  getProposal = getFeedbackRuleProposal,
  decide = decideFeedbackRuleProposal,
  apply = applyProposal,
  send = sendMessage,
  telegramApi = telegram,
} = {}) {
  return {
    id: "feedback",
    help: "💬 피드백\n공고 메시지에 평소 말투로 답장\n/feedback : 봇이 이해한 최근 취향 확인\n‘방금 거 취소’로 최근 피드백 되돌리기\n영구 규칙은 적용 전에 한 번만 확인\n‘피드백 규칙 보여줘’로 확인·삭제",
    commands: [{ command: "feedback", description: "💬 봇이 이해한 최근 취향" }],

    canHandleCallback(query) {
      return /^f:(?:ap|cn):\d+$/.test(String(query.data || ""));
    },

    async handleCallback(query) {
      const [, action, rawId] = String(query.data || "").split(":");
      const proposal = getProposal(Number(rawId));
      if (!proposal || proposal.status !== "proposed") {
        await telegramApi("answerCallbackQuery", {
          callback_query_id: query.id,
          text: "이미 처리됐거나 찾을 수 없는 제안입니다.",
        });
        return;
      }
      if (action === "cn") {
        decide(proposal.id, "rejected");
        await telegramApi("answerCallbackQuery", { callback_query_id: query.id, text: "규칙을 적용하지 않았습니다." });
        await send(`취소했습니다: ${proposal.instruction}`);
        return;
      }
      try {
        const targetRef = apply(proposal);
        decide(proposal.id, "approved", targetRef);
        await telegramApi("answerCallbackQuery", { callback_query_id: query.id, text: "규칙을 적용했습니다." });
        await send(`⚙️ 앞으로 적용합니다: ${proposal.instruction}`);
      } catch (error) {
        await telegramApi("answerCallbackQuery", {
          callback_query_id: query.id,
          text: "규칙 적용에 실패했습니다.",
          show_alert: true,
        });
        throw error;
      }
    },

    async handleMessage(message) {
      const text = String(message.text || "").trim();
      if (undoFeedbackPattern.test(text)) {
        await send(formatUndoResult(undoLatestFeedback({ text })));
        return true;
      }
      if (/^\/feedback(?:@\w+)?$/i.test(text) || /^(?:내\s*)?피드백(?:\s*(?:기록|보여줘|확인))$/.test(text)) {
        const events = recentFeedbackEvents(20).filter((event) => ["positive", "negative", "mixed"].includes(event.signal));
        const labels = { positive: "좋음", negative: "아쉬움", mixed: "혼합" };
        const lines = events.slice(0, 10).map((event, index) => {
          let interpretation = null;
          try { interpretation = JSON.parse(event.metadata_json || "{}").interpretation; } catch { /* legacy event */ }
          const learned = interpretation?.preference || event.subject_value || "세부 내용 없음";
          const area = event.domain === "housing" ? "주택" : event.domain === "jobs" ? "채용" : event.domain;
          return `${index + 1}. [${area}·${labels[event.signal]}] ${learned}`;
        });
        await send(lines.length
          ? `최근 반영 중인 피드백\n\n${lines.join("\n")}\n\n잘못 이해한 가장 최근 항목은 ‘방금 거 취소’로 되돌릴 수 있어요.`
          : "아직 반영 중인 추천 피드백이 없습니다.");
        return true;
      }
      if (/^\/?feedback_rules(?:@\w+)?$/i.test(text) || /^피드백[ \t]*규칙(?:[ \t]*(?:목록|보여줘))?$/.test(text)) {
        const jobRules = listFeedbackRules("jobs");
        const housingRules = listHousingRules();
        const lines = [
          "적용 중인 피드백 규칙",
          "",
          ...jobRules.map((rule) => `J${rule.id}. ${rule.instruction}`),
          ...housingRules.map((rule) => `H${rule.id}. ${rule.instruction}`),
        ];
        if (!jobRules.length && !housingRules.length) lines.push("현재 적용 중인 규칙이 없습니다.");
        else lines.push("", "삭제 예: ‘J2 규칙 삭제’ 또는 ‘H3 규칙 삭제’");
        await send(lines.join("\n"));
        return true;
      }
      const deletion = text.match(/^([JH])(\d+)[ \t]*규칙[ \t]*(?:삭제|취소)$/i);
      if (!deletion) return false;
      const id = Number(deletion[2]);
      const deleted = deletion[1].toUpperCase() === "J"
        ? disableFeedbackRule(id)
        : disableHousingRule(id);
      await send(deleted ? `${deletion[1].toUpperCase()}${id} 규칙을 삭제했습니다.` : "활성 상태인 규칙을 찾지 못했습니다.");
      return true;
    },
  };
}

export const feedbackBotModule = createFeedbackBotModule();
