import { sendJobApplicationStatus, sendJobReport } from "./report.mjs";
import {
  getJobPosting, jobApplicationStatus, jobsForDigest, setJobApplication,
} from "./db.mjs";
import { sendMessage, telegram } from "../../telegram.mjs";
import { recordFeedbackEvent, telegramMessageContext } from "../../core/state.mjs";
import {
  ruleProposalKeyboard,
  ruleProposalMessage,
  parseEntityFeedback,
  saveInterpretedFeedback,
} from "../feedback/service.mjs";
import { formatUndoResult, undoFeedbackPattern, undoLatestFeedback } from "../feedback/undo.mjs";
import { proposeJobApplicationFollowup } from "./application-followup.mjs";
import { feedbackTargetQuestion, resolveFeedbackTarget } from "../feedback/reference.mjs";
import { feedbackAiEnabled, interpretFeedback } from "../feedback/ai-parser.mjs";


async function sendApplicationConfirmation(job) {
  const intro = `✅ 지원 진행 중으로 저장했습니다. 추천에서는 제외하고 지원 이력으로 추적합니다.\n${job.company} — ${job.title}`;
  const reminder = await proposeJobApplicationFollowup(job, { intro });
  if (!reminder) await sendMessage(`${intro}\n\n/job_status : 지원 현황 확인`);
}

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
      const previousApplicationStatus = jobApplicationStatus(id);
      setJobApplication(id, "applied");
      recordFeedbackEvent({
        domain: "jobs", entityId: id, signal: "applied", subjectType: "company", subjectValue: job.company,
        rawText: "telegram callback", metadata: {
          company: job.company, title: job.title, source: job.source, previousApplicationStatus,
        },
      });
      await telegram("answerCallbackQuery", { callback_query_id: query.id, text: "지원 추적 중으로 저장했습니다." });
      await sendApplicationConfirmation(job);
    } else {
      const previousApplicationStatus = jobApplicationStatus(id);
      setJobApplication(id, "ignored");
      recordFeedbackEvent({
        domain: "jobs", entityId: id, signal: "ignored", subjectType: "company", subjectValue: job.company,
        rawText: "telegram callback", metadata: {
          company: job.company, title: job.title, source: job.source, previousApplicationStatus,
        },
      });
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
    if (!replyMessageId) return false;
    const deliveryContext = telegramMessageContext(replyMessageId);
    const candidates = jobsForDigest(replyMessageId).map((job) => ({ ...job, index: job.item_index }));
    if (deliveryContext?.domain === "jobs" && deliveryContext?.kind === "digest") {
      for (const item of deliveryContext.items || []) {
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
    if (undoFeedbackPattern.test(text)) {
      const resolution = resolveFeedbackTarget(text, candidates);
      await sendMessage(formatUndoResult(undoLatestFeedback({
        domain: "jobs", entityId: resolution.item?.id || null, text,
      })));
      return true;
    }
    let interpretation = null;
    if (feedbackAiEnabled()) {
      try {
        interpretation = await interpretFeedback(text, { domain: "jobs", items: candidates });
      } catch (error) {
        console.error("Feedback AI failed; using deterministic fallback", error.message);
      }
    }
    let job = interpretation?.targetIndex
      ? candidates.find((candidate) => Number(candidate.index) === interpretation.targetIndex)
      : null;
    if (!interpretation) {
      const resolution = resolveFeedbackTarget(text, candidates);
      job = resolution.item;
      if (!job) {
        await sendMessage(feedbackTargetQuestion(candidates, resolution));
        return true;
      }
      {
        const parsed = parseEntityFeedback(text, { domain: "jobs", company: job.company });
        if (!parsed) {
          await sendMessage("공고는 찾았습니다. 평소 말투로 의견을 알려주세요. 예: ‘괜찮아 보이네’, ‘좀 별로’, ‘지원했어’, ‘이 회사 다음부터 빼줘’. ");
          return true;
        }
        interpretation = {
          intent: parsed.durableRule ? "durable_rule" : parsed.signal,
          scope: parsed.durableRule ? "company" : "item",
          strength: "medium",
          preference: text,
          keywords: [],
          ruleKind: parsed.durableRule ? "exclude_company" : "none",
          ruleKeyword: parsed.durableRule?.keyword || null,
          confidence: 100,
          reason: "명시적 표현 규칙으로 해석",
          source: "rules",
        };
      }
    }
    if (interpretation.intent === "clarify") {
      await sendMessage(interpretation.clarification || "어느 공고에 대한 어떤 의견인지 조금만 더 알려주세요.");
      return true;
    }
    if (interpretation.intent === "not_feedback") {
      await sendMessage("공고에 대한 의견으로 이해하지 못했어요. 좋거나 아쉬운 점을 평소 말투로 조금만 더 알려주세요.");
      return true;
    }
    if (interpretation.intent === "undo") {
      await sendMessage(formatUndoResult(undoLatestFeedback({
        domain: "jobs", entityId: job?.id || null, text,
      })));
      return true;
    }
    if (!job) {
      await sendMessage("어느 공고에 대한 의견인지 회사명이나 번호를 한 번만 알려주세요.");
      return true;
    }
    if (interpretation.intent === "applied") {
      const previousApplicationStatus = jobApplicationStatus(job.id);
      setJobApplication(job.id, "applied");
      recordFeedbackEvent({
        domain: "jobs", entityId: job.id, signal: "applied", subjectType: "company", subjectValue: job.company,
        rawText: text, metadata: {
          company: job.company, title: job.title, source: job.source, previousApplicationStatus,
          interpretation,
        },
      });
      await sendApplicationConfirmation(job);
      return true;
    }
    const previousApplicationStatus = jobApplicationStatus(job.id);
    const feedback = saveInterpretedFeedback({
      domain: "jobs",
      entityId: job.id,
      text,
      title: job.title,
      company: job.company,
      source: job.source,
      interpretation,
      metadata: { previousApplicationStatus },
    });
    if (!feedback) {
      await sendMessage("피드백 의미를 안전하게 적용하지 못했습니다. 의견을 조금만 더 구체적으로 알려주세요.");
      return true;
    }
    if (feedback.signal === "negative") {
      setJobApplication(job.id, "ignored");
      if (feedback.proposal) {
        await sendMessage(ruleProposalMessage(
          feedback.proposal,
          `이 공고는 즉시 숨기고, 승인하면 ${job.company}의 향후 공고도 제외`,
        ), { reply_markup: ruleProposalKeyboard(feedback.proposal) });
      } else {
        await sendMessage(`🧠 이렇게 이해했어요: ${interpretation.preference || interpretation.reason}\n이 공고는 추천에서 제외했습니다.\n${job.company} — ${job.title}`);
      }
    } else if (feedback.signal === "mixed") {
      await sendMessage(`🧠 이렇게 이해했어요: ${interpretation.preference || interpretation.reason}\n좋고 아쉬운 점을 함께 저장했습니다. 아직 이 공고를 숨기지는 않았어요.\n${job.company} — ${job.title}`);
    } else {
      await sendMessage(`🧠 이렇게 이해했어요: ${interpretation.preference || interpretation.reason}\n다음 추천 순서에 반영합니다.\n${job.company} — ${job.title}`);
    }
    return true;
  },
};
