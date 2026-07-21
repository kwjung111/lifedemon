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
import { formatUndoResult, undoLatestFeedback } from "./undo.mjs";
import { proposeExplicitRule, ruleProposalKeyboard, ruleProposalMessage } from "./service.mjs";

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

function commandName(text) {
  if (!text.startsWith("/")) return null;
  return text.slice(1).split(/\s/, 1)[0].split("@", 1)[0].toLowerCase();
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

    canHandleMessage(_message, context) {
      return [
        "feedback_undo", "feedback_history", "feedback_rules_list", "feedback_rule_delete", "preference_rule",
      ].includes(context?.semantic?.route);
    },

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

    async handleMessage(message, context = null) {
      const text = String(message.text || "").trim();
      const semantic = context?.semantic;
      if (semantic?.route === "feedback_undo") {
        await send(formatUndoResult(undoLatestFeedback({ domain: semantic.domain, text })));
        return true;
      }
      if (semantic?.route === "preference_rule") {
        const valid = (semantic.domain === "housing" && semantic.ruleKind === "exclude_keyword")
          || (semantic.domain === "jobs" && semantic.ruleKind === "exclude_company");
        if (!valid || !semantic.ruleKeyword) {
          await send("앞으로 적용할 제외 기준을 조금 더 구체적으로 알려 주세요.");
          return true;
        }
        const proposal = proposeExplicitRule({
          domain: semantic.domain,
          kind: semantic.ruleKind,
          keyword: semantic.ruleKeyword,
          instruction: semantic.preference || `${semantic.ruleKeyword} 제외`,
        });
        await send(ruleProposalMessage(proposal, "다음 수집부터 적용"), {
          reply_markup: ruleProposalKeyboard(proposal),
        });
        return true;
      }
      if (commandName(text) === "feedback" || semantic?.route === "feedback_history") {
        const events = recentFeedbackEvents(20).filter((event) => ["positive", "negative", "mixed"].includes(event.signal));
        const labels = { positive: "좋음", negative: "아쉬움", mixed: "혼합" };
        const lines = events.slice(0, 10).map((event, index) => {
          let interpretation = null;
          try { interpretation = JSON.parse(event.metadata_json || "{}").interpretation; } catch { /* legacy event */ }
          const learned = interpretation?.preference || event.subject_value || "세부 내용 없음";
          const aspects = (interpretation?.aspects || []).map((aspect) =>
            `${aspect.scope} ${aspect.sentiment === "positive" ? "👍" : "👎"} ${aspect.keyword}`
          ).join(" · ");
          const area = event.domain === "housing" ? "주택" : event.domain === "jobs" ? "채용" : event.domain;
          return `${index + 1}. [${area}·${labels[event.signal]}] ${learned}${aspects ? `\n   ${aspects}` : ""}`;
        });
        await send(lines.length
          ? `최근 반영 중인 피드백\n\n${lines.join("\n")}\n\n잘못 이해한 가장 최근 항목은 ‘방금 거 취소’로 되돌릴 수 있어요.`
          : "아직 반영 중인 추천 피드백이 없습니다.");
        return true;
      }
      if (["feedback_rules"].includes(commandName(text)) || semantic?.route === "feedback_rules_list") {
        const jobRules = semantic?.domain === "housing" ? [] : listFeedbackRules("jobs");
        const housingRules = semantic?.domain === "jobs" ? [] : listHousingRules();
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
      if (semantic?.route !== "feedback_rule_delete" || !semantic.ruleId || !["jobs", "housing"].includes(semantic.domain)) return false;
      const id = semantic.ruleId;
      const prefix = semantic.domain === "jobs" ? "J" : "H";
      const deleted = semantic.domain === "jobs"
        ? disableFeedbackRule(id)
        : disableHousingRule(id);
      await send(deleted ? `${prefix}${id} 규칙을 삭제했습니다.` : "활성 상태인 규칙을 찾지 못했습니다.");
      return true;
    },
  };
}

export const feedbackBotModule = createFeedbackBotModule();
