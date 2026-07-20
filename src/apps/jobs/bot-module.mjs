import { sendJobApplicationStatus, sendJobReport } from "./report.mjs";
import {
  getJobPosting, jobApplicationStatus, jobRecommendationHidden, jobsForDigest,
  setJobApplication, setJobRecommendationHidden,
} from "./db.mjs";
import { sendMessage, telegram } from "../../telegram.mjs";
import { recordFeedbackEvent, telegramMessageContext } from "../../core/state.mjs";
import {
  ruleProposalKeyboard,
  ruleProposalMessage,
  saveInterpretedFeedback,
} from "../feedback/service.mjs";
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
      || (["feedback", "feedback_undo"].includes(semantic?.route) && semantic?.domain === "jobs");
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
    if (!["feedback", "feedback_undo"].includes(semantic?.route) || semantic.domain !== "jobs") return false;
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
    const feedbackContext = { domain: "jobs", kind: "digest", items: candidates.map((item) => ({ index: item.index, id: item.id })) };
    if (semantic.route === "feedback_undo") {
      const undoTarget = semantic.targetIndex
        ? candidates.find((candidate) => Number(candidate.index) === semantic.targetIndex)
        : null;
      await sendMessage(formatUndoResult(undoLatestFeedback({
        domain: "jobs", entityId: undoTarget?.id || null, text: feedbackText,
      })));
      return true;
    }
    const interpretation = {
      intent: semantic.feedbackIntent,
      targetIndex: semantic.targetIndex,
      scope: semantic.scope,
      strength: semantic.strength,
      preference: semantic.preference,
      keywords: semantic.keywords,
      aspects: semantic.aspects,
      ruleKind: semantic.ruleKind,
      ruleKeyword: semantic.ruleKeyword,
      confidence: semantic.confidence,
      reason: semantic.reason,
      clarification: semantic.clarification,
      source: "global-ai",
    };
    const job = semantic.targetIndex
      ? candidates.find((candidate) => Number(candidate.index) === semantic.targetIndex)
      : null;
    if (interpretation.intent === "clarify") {
      await sendMessage(
        interpretation.clarification || "어느 공고에 대한 어떤 의견인지 조금만 더 알려주세요.",
        {}, { context: { ...feedbackContext, pendingFeedback: feedbackText } },
      );
      return true;
    }
    if (interpretation.intent === "not_feedback") {
      await sendMessage("공고에 대한 의견으로 이해하지 못했어요. 좋거나 아쉬운 점을 평소 말투로 조금만 더 알려주세요.", {}, {
        context: { ...feedbackContext, pendingFeedback: feedbackText },
      });
      return true;
    }
    if (interpretation.intent === "undo") {
      await sendMessage(formatUndoResult(undoLatestFeedback({
        domain: "jobs", entityId: job?.id || null, text: feedbackText,
      })));
      return true;
    }
    if (!job) {
      await sendMessage("어느 공고에 대한 의견인지 회사명이나 번호를 한 번만 알려주세요.", {}, {
        context: { ...feedbackContext, pendingFeedback: feedbackText },
      });
      return true;
    }
    if (interpretation.intent === "applied") {
      const previousApplicationStatus = jobApplicationStatus(job.id);
      setJobApplication(job.id, "applied");
      recordFeedbackEvent({
        domain: "jobs", entityId: job.id, signal: "applied", subjectType: "company", subjectValue: job.company,
        sourceKey: message.message_id ? `message:${message.message_id}` : null,
        rawText: feedbackText, metadata: {
          company: job.company, title: job.title, source: job.source, previousApplicationStatus,
          interpretation,
        },
      });
      await sendApplicationConfirmation(job);
      return true;
    }
    const previousApplicationStatus = jobApplicationStatus(job.id);
    const previousRecommendationHidden = jobRecommendationHidden(job.id);
    const feedback = saveInterpretedFeedback({
      domain: "jobs",
      entityId: job.id,
      text: feedbackText,
      title: job.title,
      company: job.company,
      source: job.source,
      interpretation,
      metadata: { previousApplicationStatus, previousRecommendationHidden },
      sourceKey: message.message_id ? `message:${message.message_id}` : null,
    });
    if (!feedback) {
      await sendMessage("피드백 의미를 안전하게 적용하지 못했습니다. 의견을 조금만 더 구체적으로 알려주세요.");
      return true;
    }
    if (feedback.signal === "negative") {
      setJobRecommendationHidden(job.id, true);
      if (feedback.proposal) {
        await sendMessage(ruleProposalMessage(
          feedback.proposal,
          `이 공고는 즉시 숨기고, 승인하면 ${job.company}의 향후 공고도 제외`,
        ), { reply_markup: ruleProposalKeyboard(feedback.proposal) }, { context: feedbackContext });
      } else if (feedback.alreadyActive) {
        await sendMessage(`이미 앞으로 제외 중인 회사예요. 현재 공고도 숨겼습니다.\n${job.company} — ${job.title}`, {}, { context: feedbackContext });
      } else {
        await sendMessage(`🧠 이렇게 이해했어요: ${interpretation.preference || interpretation.reason}\n이 공고는 추천에서 제외했습니다.\n${job.company} — ${job.title}`, {}, { context: feedbackContext });
      }
    } else if (feedback.signal === "mixed") {
      await sendMessage(`🧠 이렇게 이해했어요: ${interpretation.preference || interpretation.reason}\n좋고 아쉬운 점을 함께 저장했습니다. 아직 이 공고를 숨기지는 않았어요.\n${job.company} — ${job.title}`, {}, { context: feedbackContext });
    } else {
      setJobRecommendationHidden(job.id, false);
      await sendMessage(`🧠 이렇게 이해했어요: ${interpretation.preference || interpretation.reason}\n다음 추천 순서에 반영합니다.\n${job.company} — ${job.title}`, {}, { context: feedbackContext });
    }
    return true;
  },
  };
}

export const jobsBotModule = createJobsBotModule();
