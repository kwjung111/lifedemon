import { sendMoreRecommendations, sendMorningBriefing } from "./report.mjs";

function pageOffset(domain, context) {
  if (!context) return 0;
  if (context.domain === domain) return Number(context.nextOffset) || context.items?.length || 0;
  if (context.domain === "briefing") return Number(context.shownByDomain?.[domain]) || 0;
  return 0;
}

export const briefingBotModule = {
  id: "briefing",
  help: "☀️ 통합 브리핑\n/briefing : 오늘 할 일과 주택·채용 핵심 추천\n브리핑에 답장: ‘주택 더 보여줘’, ‘4번 지원했어’",
  commands: [{ command: "briefing", description: "☀️ 오늘의 통합 브리핑" }],
  canHandleCallback() { return false; },
  canHandleMessage(_message, context) {
    return ["briefing_show", "recommendations_list", "recommendations_next"].includes(context?.semantic?.route);
  },

  async handleMessage(message, routedContext = null) {
    const text = String(message.text || "").trim();
    if (/^\/briefing(?:@\w+)?$/i.test(text) || routedContext?.semantic?.route === "briefing_show") {
      await sendMorningBriefing();
      return true;
    }
    const semantic = routedContext?.semantic;
    if (["recommendations_list", "recommendations_next"].includes(semantic?.route)
      && ["jobs", "housing"].includes(semantic.domain)) {
      const offset = semantic.route === "recommendations_next" ? pageOffset(semantic.domain, routedContext) : 0;
      await sendMoreRecommendations(semantic.domain, { offset });
      return true;
    }
    return false;
  },
};
