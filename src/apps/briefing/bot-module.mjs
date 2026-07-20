import { telegramMessageContext } from "../../core/state.mjs";
import { sendMessage } from "../../telegram.mjs";
import { feedbackTargetQuestion, resolveFeedbackTarget } from "../feedback/reference.mjs";
import { housingBotModule } from "../housing/bot-module.mjs";
import { jobsBotModule } from "../jobs/bot-module.mjs";
import { briefingItem, sendMorningBriefing } from "./report.mjs";

export const briefingBotModule = {
  id: "briefing",
  help: "☀️ 통합 브리핑\n/briefing : 오늘 할 일과 주택·채용 핵심 추천\n브리핑에 답장: ‘주택 더 보여줘’, ‘4번 지원했어’",
  commands: [{ command: "briefing", description: "☀️ 오늘의 통합 브리핑" }],
  canHandleCallback() { return false; },

  async handleMessage(message) {
    const text = String(message.text || "").trim();
    if (/^\/briefing(?:@\w+)?$/i.test(text) || /^오늘(?:의)?\s*브리핑(?:\s*보여줘)?$/i.test(text)) {
      await sendMorningBriefing();
      return true;
    }
    const replyMessageId = message.reply_to_message?.message_id;
    const context = replyMessageId ? telegramMessageContext(replyMessageId) : null;
    if (context?.domain !== "briefing") return false;
    const feedbackText = context.pendingFeedback ? `${context.pendingFeedback}\n추가 답변: ${text}` : text;
    const { items } = briefingItem(context, feedbackText);
    const resolution = resolveFeedbackTarget(feedbackText, items);
    if (!resolution.item) {
      await sendMessage(feedbackTargetQuestion(items, resolution), {}, {
        context: { ...context, pendingFeedback: feedbackText },
      });
      return true;
    }
    const delegated = {
      ...message,
      briefingTarget: resolution.item,
      briefingFeedbackText: feedbackText,
    };
    return resolution.item.domain === "housing"
      ? housingBotModule.handleMessage(delegated)
      : jobsBotModule.handleMessage(delegated);
  },
};
