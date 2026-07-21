import { sendMessage, telegram } from "../../telegram.mjs";
import { buildSystemSnapshot } from "./snapshot.mjs";
import { answerManagerQuestion } from "./query.mjs";
import { askManagerConversation } from "./conversation.mjs";

function stripCommand(text) {
  return String(text || "").replace(/^\/(?:daemon|system|ask)(?:@\w+)?\s*/i, "").trim();
}

export function createManagerBotModule({
  snapshot = buildSystemSnapshot,
  answer = answerManagerQuestion,
  converse = answer,
  send = sendMessage,
} = {}) {
  let lastExchange = null;
  return {
    id: "manager",
    help: "🧭 Life Daemon 관리\n/daemon : 전체 운영 상태\n/ask 질문 : 읽기 전용 에이전트가 로그·서비스·DB·서버 상태를 자율 조사\n예: ‘채용공고 우선순위가 어떻게 돼?’, ‘채용 수집이 왜 실패했지?’",
    commands: [
      { command: "daemon", description: "🧭 전체 시스템 상태" },
      { command: "ask", description: "🧭 Life Daemon에 자연어로 질문" },
    ],

    canHandleMessage(message, context) {
      const text = String(message.text || "").trim();
      const command = text.startsWith("/") ? text.slice(1).split(/\s/, 1)[0].split("@", 1)[0].toLowerCase() : null;
      return ["daemon", "system", "ask"].includes(command) || context?.semantic?.route === "manager_question";
    },

    async handleMessage(message, routedContext = null) {
      const text = String(message.text || "").trim();
      const command = text.startsWith("/") ? text.slice(1).split(/\s/, 1)[0].split("@", 1)[0].toLowerCase() : null;
      const semantic = routedContext?.semantic;
      if (!["daemon", "system", "ask"].includes(command) && semantic?.route !== "manager_question") return false;
      const rawQuestion = semantic?.question || stripCommand(text) || "전체 시스템 상태와 최근 수집 시각을 알려줘";
      const isAsk = command === "ask";
      const replyContext = message.reply_to_message?.from?.is_bot
        ? String(message.reply_to_message.text || "").trim().slice(0, 2500)
        : "";
      const recentContext = lastExchange && Date.now() - lastExchange.at < 15 * 60_000
        ? `${lastExchange.question}\n${lastExchange.answer}`.slice(-2500)
        : "";
      const context = replyContext || (semantic?.followUp ? recentContext : "");
      const question = context
        ? `이전 대화:\n${context}\n\n현재 질문:\n${rawQuestion}`
        : rawQuestion;
      const showTyping = message.chat?.id
        ? () => telegram("sendChatAction", { chat_id: message.chat.id, action: "typing" }).catch(() => null)
        : null;
      if (showTyping) await showTyping();
      const heartbeat = showTyping ? setInterval(showTyping, 4000) : null;
      heartbeat?.unref?.();
      let result;
      try {
        const currentSnapshot = snapshot();
        if (isAsk) {
          try {
            result = await converse(rawQuestion, currentSnapshot);
          } catch (error) {
            console.error("Manager conversation failed; using diagnostic fallback", error.message);
            result = await answer(question, currentSnapshot);
          }
        } else {
          result = await answer(question, currentSnapshot);
        }
      } finally {
        if (heartbeat) clearInterval(heartbeat);
      }
      await send(result);
      lastExchange = { question: rawQuestion, answer: result, at: Date.now() };
      return true;
    },
  };
}

export const managerBotModule = createManagerBotModule({ converse: askManagerConversation });
