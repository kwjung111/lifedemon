import { sendJobApplicationStatus, sendJobReport } from "./report.mjs";
import {
  getJobPosting, jobApplicationStatus, jobRecommendationHidden, jobsForDigest,
  setJobApplication, setJobRecommendationHidden,
} from "./db.mjs";
import { sendMessage, telegram } from "../../telegram.mjs";
import { recordFeedbackEvent, telegramMessageContext } from "../../core/state.mjs";
import { formatUndoResult, undoLatestFeedback } from "../feedback/undo.mjs";
import { proposeJobApplicationFollowup } from "./application-followup.mjs";


async function sendApplicationConfirmation(job) {
  const intro = `✅ 지원 진행 중으로 저장했습니다. 추천에서는 제외하고 지원 이력으로 추적합니다.\n${job.company} — ${job.title}`;
  const reminder = await proposeJobApplicationFollowup(job, { intro });
  if (!reminder) await sendMessage(`${intro}\n\n/job_status : 지원 현황 확인`);
}

export function createJobsBotModule() {
  return {
  id: "jobs",
  help: "💼 채용 공고\n/jobs : 현재 채용 공고와 AI 판정 보기\n/job_status : 지원 진행 중인 채용공고 보기\n‘지원했어’는 지원 추적, ‘관심없어’는 추천에서만 제외",
  commands: [
    { command: "jobs", description: "💼 최신 채용 공고와 AI 판정" },
    { command: "job_status", description: "💼 지원 중인 채용 공고" },
  ],

  canHandleMessage(_message, context) {
    const semantic = context?.semantic;
    return semantic?.route === "job_status"
      || (semantic?.route === "feedback_undo" && semantic?.domain === "jobs");
  },

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
      const previousApplicationStatus = jobApplicationStatus(id);
      setJobApplication(id, "applied");
      recordFeedbackEvent({
        domain: "jobs", entityId: id, signal: "applied", subjectType: "company", subjectValue: job.company,
        sourceKey: query.id ? `callback:${query.id}` : null,
        rawText: "telegram callback", metadata: {
          company: job.company, title: job.title, source: job.source, previousApplicationStatus,
        },
      });
      await telegram("answerCallbackQuery", { callback_query_id: query.id, text: "지원 추적 중으로 저장했습니다." });
      await sendApplicationConfirmation(job);
    } else {
      const previousApplicationStatus = jobApplicationStatus(id);
      const previousRecommendationHidden = jobRecommendationHidden(id);
      setJobRecommendationHidden(id, true);
      recordFeedbackEvent({
        domain: "jobs", entityId: id, signal: "ignored", subjectType: "company", subjectValue: job.company,
        sourceKey: query.id ? `callback:${query.id}` : null,
        rawText: "telegram callback", metadata: {
          company: job.company, title: job.title, source: job.source,
          previousApplicationStatus, previousRecommendationHidden,
        },
      });
      await telegram("answerCallbackQuery", { callback_query_id: query.id, text: "관심 없음으로 저장했습니다." });
      await sendMessage(`🚫 관심 없음으로 저장했습니다. 추천에서만 제외하며 지원 이력에는 넣지 않습니다.\n${job.company} — ${job.title}`);
    }
  },

  async handleMessage(message, routedContext = null) {
    const text = String(message.text || "").trim();
    if (/^\/jobs(?:@\w+)?$/i.test(text)) {
      await sendJobReport();
      return true;
    }
    if (/^\/(?:job|jobs)_status(?:@\w+)?$/i.test(text) || routedContext?.semantic?.route === "job_status") {
      await sendJobApplicationStatus();
      return true;
    }
    const replyMessageId = message.reply_to_message?.message_id;
    if (!replyMessageId) return false;
    const deliveryContext = routedContext || telegramMessageContext(replyMessageId);
    const semantic = deliveryContext?.semantic;
    if (semantic?.route !== "feedback_undo" || semantic.domain !== "jobs") return false;
    const feedbackText = message.briefingFeedbackText || (deliveryContext?.pendingFeedback
      ? `${deliveryContext.pendingFeedback}\n추가 답변: ${text}`
      : text);
    const candidates = message.briefingTarget?.domain === "jobs"
      ? [{ ...message.briefingTarget, ...getJobPosting(message.briefingTarget.id), index: message.briefingTarget.index }]
      : jobsForDigest(replyMessageId).map((job) => ({ ...job, index: job.item_index }));
    if (["jobs", "briefing"].includes(deliveryContext?.domain)) {
      for (const item of deliveryContext.items || []) {
        if (item.domain && item.domain !== "jobs") continue;
        if (candidates.some((candidate) => candidate.id === item.id)) continue;
        const job = getJobPosting(item.id);
        if (job) candidates.push({ ...job, index: item.index });
      }
    }
    if (deliveryContext?.domain === "jobs" && deliveryContext?.kind === "item" && deliveryContext.entityId) {
      const job = getJobPosting(deliveryContext.entityId);
      if (job) candidates.push({ ...job, index: 1 });
    }
    if (!candidates.length) return false;
    const undoTarget = semantic.targetIndex
      ? candidates.find((candidate) => Number(candidate.index) === semantic.targetIndex)
      : null;
    await sendMessage(formatUndoResult(undoLatestFeedback({
      domain: "jobs", entityId: undoTarget?.id || null, text: feedbackText,
    })));
    return true;
  },
  };
}

export const jobsBotModule = createJobsBotModule();
