import { telegramMessageContext } from "../../core/state.mjs";
import { sendMessage } from "../../telegram.mjs";
import { feedbackTargetQuestion, resolveFeedbackTarget } from "../feedback/reference.mjs";
import { housingBotModule } from "../housing/bot-module.mjs";
import { jobsBotModule } from "../jobs/bot-module.mjs";
import { briefingItem, sendMoreRecommendations, sendMorningBriefing } from "./report.mjs";

const housingWords = /(?:주택|임대|청약)/;
const jobWords = /(?:채용|직업|잡)/;
const listWords = /(?:보여|알려|목록|꺼내|확인)/;
const quantityWords = /(?:더|나머지|다|전부|전체|모두)/;

function normalizedRequest(text) {
  return String(text || "").trim().replace(/[.!?？~]+$/g, "").replace(/\s+/g, " ");
}

function domainListRequest(text, domainWords) {
  const value = normalizedRequest(text);
  return domainWords.test(value) && listWords.test(value);
}

function genericMoreRequest(text) {
  const value = normalizedRequest(text);
  return quantityWords.test(value) && listWords.test(value)
    && !housingWords.test(value) && !jobWords.test(value);
}

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
    const wantsHousing = domainListRequest(text, housingWords);
    const wantsJobs = domainListRequest(text, jobWords);
    const wantsNextPage = genericMoreRequest(text);
    if (!replyMessageId && wantsHousing) {
      await sendMoreRecommendations("housing");
      return true;
    }
    if (!replyMessageId && wantsJobs) {
      await sendMoreRecommendations("jobs");
      return true;
    }
    if (context?.domain === "housing" && (wantsHousing || wantsNextPage)) {
      await sendMoreRecommendations("housing", {
        offset: Number(context.nextOffset) || context.items?.length || 0,
      });
      return true;
    }
    if (context?.domain === "jobs" && (wantsJobs || wantsNextPage)) {
      await sendMoreRecommendations("jobs", {
        offset: Number(context.nextOffset) || context.items?.length || 0,
      });
      return true;
    }
    if (context?.domain !== "briefing") return false;
    if (wantsHousing) {
      await sendMoreRecommendations("housing", { offset: Number(context.shownByDomain?.housing) || 0 });
      return true;
    }
    if (wantsJobs) {
      await sendMoreRecommendations("jobs", { offset: Number(context.shownByDomain?.jobs) || 0 });
      return true;
    }
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
