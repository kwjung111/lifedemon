import { sendJobReport } from "./report.mjs";
import { getJobPosting, jobForDigestItem, setJobApplication } from "./db.mjs";
import { sendMessage, telegram } from "../../telegram.mjs";

const appliedWords = /지원했|지원함|지원 완료|넣었|접수했/;

export const jobsBotModule = {
  id: "jobs",
  help: "💼 채용 공고\n/jobs : 현재 채용 공고와 AI 판정 보기\n알림의 ‘N번 지원했어’ 버튼 또는 답장: ‘N번 지원했어’",
  commands: [{ command: "jobs", description: "채용 공고 현황과 AI 판정 보기" }],

  canHandleCallback(query) {
    return String(query.data || "").startsWith("j:ap:");
  },

  async handleCallback(query) {
    const id = String(query.data || "").split(":")[2];
    const job = getJobPosting(id);
    if (!job) {
      await telegram("answerCallbackQuery", { callback_query_id: query.id, text: "공고를 찾지 못했습니다." });
      return;
    }
    setJobApplication(id, "applied");
    await telegram("answerCallbackQuery", { callback_query_id: query.id, text: "지원 완료로 저장했습니다." });
    await sendMessage(`✅ 지원 완료로 저장했습니다. 다음 채용 알림부터 제외합니다.\n${job.company} — ${job.title}`);
  },

  async handleMessage(message) {
    const text = String(message.text || "").trim();
    if (/^\/jobs(?:@\w+)?$/i.test(text)) {
      await sendJobReport();
      return true;
    }
    const replyMessageId = message.reply_to_message?.message_id;
    const itemNumber = Number(text.match(/^\s*(\d{1,2})\s*번?/)?.[1] || 0);
    if (!replyMessageId || !itemNumber || !appliedWords.test(text)) return false;
    const job = jobForDigestItem(replyMessageId, itemNumber);
    if (!job) return false;
    setJobApplication(job.id, "applied");
    await sendMessage(`✅ 지원 완료로 저장했습니다. 다음 채용 알림부터 제외합니다.\n${job.company} — ${job.title}`);
    return true;
  },
};
