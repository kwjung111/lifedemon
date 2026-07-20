import { sendMorningBriefing } from "./report.mjs";

export const briefingBotModule = {
  id: "briefing",
  help: "☀️ 통합 브리핑\n/briefing : 오늘 할 일과 주택·채용 핵심 추천\n브리핑에 답장: ‘주택 더 보여줘’, ‘4번 지원했어’",
  commands: [{ command: "briefing", description: "☀️ 오늘의 통합 브리핑" }],
  canHandleCallback() { return false; },
  canHandleMessage(_message, context) { return context?.semantic?.route === "briefing_show"; },

  async handleMessage(message, routedContext = null) {
    const text = String(message.text || "").trim();
    if (/^\/briefing(?:@\w+)?$/i.test(text) || routedContext?.semantic?.route === "briefing_show") {
      await sendMorningBriefing();
      return true;
    }
    return false;
  },
};
