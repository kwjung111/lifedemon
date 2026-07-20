import { sendMoreRecommendations } from "../briefing/report.mjs";

function pageOffset(domain, context) {
  if (!context) return 0;
  if (context.domain === domain) {
    return Number(context.nextOffset) || context.items?.length || 0;
  }
  if (context.domain === "briefing") return Number(context.shownByDomain?.[domain]) || 0;
  return 0;
}

export function createNavigationBotModule({
  sendMore = sendMoreRecommendations,
} = {}) {
  return {
    id: "navigation",
    help: "자연어로 주택·채용 추천 목록을 요청하면 AI가 의도를 판단합니다.",
    commands: [],

    canHandleMessage(_message, context) {
      return ["recommendations_list", "recommendations_next"].includes(context?.semantic?.route);
    },

    async handleMessage(message, context = null) {
      const text = String(message.text || message.caption || "").trim();
      if (!text || text.startsWith("/")) return false;
      const result = context?.semantic;
      if (!["recommendations_list", "recommendations_next"].includes(result?.route)) return false;
      if (!["jobs", "housing"].includes(result.domain)) return false;
      const offset = result.route === "recommendations_next" ? pageOffset(result.domain, context) : 0;
      await sendMore(result.domain, { offset });
      return true;
    },
  };
}

export const navigationBotModule = createNavigationBotModule();
