import { sendMessage } from "../../telegram.mjs";
import { buildSystemSnapshot } from "./snapshot.mjs";
import { answerManagerQuestion, looksLikeManagerQuestion } from "./query.mjs";

function stripCommand(text) {
  return String(text || "").replace(/^\/(?:daemon|system|ask)(?:@\w+)?\s*/i, "").trim();
}

export function createManagerBotModule({ snapshot = buildSystemSnapshot, answer = answerManagerQuestion, send = sendMessage } = {}) {
  return {
    id: "manager",
    help: "🧭 Life Daemon 관리\n/daemon : 전체 운영 상태\n/ask 질문 : 자연어로 채용·주택·수집·서비스·알림 상태 질문\n예: ‘채용공고 우선순위가 어떻게 돼?’, ‘수집이 마지막으로 언제 돌았지?’",
    commands: [
      { command: "daemon", description: "🧭 전체 시스템 상태" },
      { command: "ask", description: "🧭 Life Daemon에 자연어로 질문" },
    ],

    async handleMessage(message) {
      const text = String(message.text || "").trim();
      if (!looksLikeManagerQuestion(text)) return false;
      const question = stripCommand(text) || "전체 시스템 상태와 최근 수집 시각을 알려줘";
      const result = await answer(question, snapshot());
      await send(result);
      return true;
    },
  };
}

export const managerBotModule = createManagerBotModule();
