import { sendJobApplicationStatus, sendJobReport } from "./report.mjs";
import { getJobPosting, jobForDigestItem, setJobApplication } from "./db.mjs";
import { sendMessage, telegram } from "../../telegram.mjs";

const appliedWords = /지원했|지원함|지원 완료|넣었|접수했/;
const ignoredWords = /관심\s*없|추천\s*제외|안\s*볼래/;

export const jobsBotModule = {
  id: "jobs",
  help: "💼 채용 공고\n/jobs : 현재 채용 공고와 AI 판정 보기\n/job_status : 지원 진행 중인 채용공고 보기\n‘지원했어’는 지원 추적, ‘관심없어’는 추천에서만 제외",
  commands: [
    { command: "jobs", description: "💼 최신 채용 공고와 AI 판정" },
    { command: "job_status", description: "💼 지원 중인 채용 공고" },
  ],

  canHandleCallback(query) {
    return /^j:(?:ap|ig):/.test(String(query.data || ""));
  },

  async handleCallback(query) {
    const [, action, id] = String(query.data || "").split(":");
    const job = getJobPosting(id);
    if (!job) {
      await telegram("answerCallbackQuery", { callback_query_id: query.id, text: "공고를 찾지 못했습니다." });
      return;
    }
    if (action === "ap") {
      setJobApplication(id, "applied");
      await telegram("answerCallbackQuery", { callback_query_id: query.id, text: "지원 추적 중으로 저장했습니다." });
      await sendMessage(`✅ 지원 진행 중으로 저장했습니다. 추천에서는 제외하고 지원 이력으로 추적합니다.\n${job.company} — ${job.title}\n\n/job_status : 지원 현황 확인`);
    } else {
      setJobApplication(id, "ignored");
      await telegram("answerCallbackQuery", { callback_query_id: query.id, text: "관심 없음으로 저장했습니다." });
      await sendMessage(`🚫 관심 없음으로 저장했습니다. 추천에서만 제외하며 지원 이력에는 넣지 않습니다.\n${job.company} — ${job.title}`);
    }
  },

  async handleMessage(message) {
    const text = String(message.text || "").trim();
    if (/^\/jobs(?:@\w+)?$/i.test(text)) {
      await sendJobReport();
      return true;
    }
    if (/^\/(?:job|jobs)_status(?:@\w+)?$/i.test(text) || /^채용\s*(?:지원)?\s*현황$/i.test(text)) {
      await sendJobApplicationStatus();
      return true;
    }
    const replyMessageId = message.reply_to_message?.message_id;
    const itemNumber = Number(text.match(/^\s*(\d{1,2})\s*번?/)?.[1] || 0);
    if (!replyMessageId || !itemNumber || (!appliedWords.test(text) && !ignoredWords.test(text))) return false;
    const job = jobForDigestItem(replyMessageId, itemNumber);
    if (!job) return false;
    if (appliedWords.test(text)) {
      setJobApplication(job.id, "applied");
      await sendMessage(`✅ 지원 진행 중으로 저장했습니다. 추천에서는 제외하고 지원 이력으로 추적합니다.\n${job.company} — ${job.title}\n\n/job_status : 지원 현황 확인`);
    } else {
      setJobApplication(job.id, "ignored");
      await sendMessage(`🚫 관심 없음으로 저장했습니다. 추천에서만 제외하며 지원 이력에는 넣지 않습니다.\n${job.company} — ${job.title}`);
    }
    return true;
  },
};
