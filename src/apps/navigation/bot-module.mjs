import { telegram } from "../../telegram.mjs";
import { sendMoreRecommendations } from "../briefing/report.mjs";
import { classifyNavigationIntent } from "./ai-parser.mjs";

function pageOffset(domain, context) {
  if (!context) return 0;
  if (context.domain === domain) {
    return Number(context.nextOffset) || context.items?.length || 0;
  }
  if (context.domain === "briefing") return Number(context.shownByDomain?.[domain]) || 0;
  return 0;
}

export function createNavigationBotModule({
  classify = classifyNavigationIntent,
  sendMore = sendMoreRecommendations,
  typing = (chatId) => telegram("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {}),
  log = console,
} = {}) {
  return {
    id: "navigation",
    help: "자연어로 주택·채용 추천 목록을 요청하면 AI가 의도를 판단합니다.",
    commands: [],

    canHandleMessage(_message, context) {
      return ["jobs", "housing", "briefing"].includes(context?.domain);
    },

    async handleMessage(message, context = null) {
      const text = String(message.text || message.caption || "").trim();
      if (!text || text.startsWith("/")) return false;
      typing(message.chat?.id);
      let result;
      try {
        result = await classify(text, context);
      } catch (error) {
        log.warn("Navigation intent AI failed", error.message);
        return false;
      }
      if (result.intent === "not_navigation") return false;
      await sendMore(result.domain, { offset: pageOffset(result.domain, context) });
      return true;
    },
  };
}

export const navigationBotModule = createNavigationBotModule();
