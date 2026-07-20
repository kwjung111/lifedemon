import {
  createFeedbackRuleProposal,
  listFeedbackRules,
  recordFeedbackEvent,
} from "../../core/state.mjs";

const positiveWords = /좋아|좋네|괜찮|마음에|끌려|유용|추천[ \t]*좋/;
const negativeWords = /별로|관심[ \t]*없|안[ \t]*끌|맘에[ \t]*안|마음에[ \t]*안|추천[ \t]*제외|안[ \t]*볼래/;
const appliedWords = /지원했|신청했|접수했|넣었|지원[ \t]*완료|신청[ \t]*완료/;
const durableWords = /앞으로|계속|항상|다시는|영구|이[ \t]*회사.*(?:빼|제외)|회사.*(?:빼|제외)/;

export function parseEntityFeedback(text, { domain, company = null } = {}) {
  const value = String(text || "").trim();
  if (!value) return null;
  if (appliedWords.test(value)) return { signal: "applied", durableRule: null };
  if (negativeWords.test(value) || durableWords.test(value)) {
    const durableRule = domain === "jobs" && company && durableWords.test(value)
      ? {
        domain: "jobs",
        kind: "exclude_company",
        keyword: String(company).trim(),
        instruction: `${String(company).trim()} 회사 제외`,
      }
      : null;
    return { signal: "negative", durableRule };
  }
  if (positiveWords.test(value)) return { signal: "positive", durableRule: null };
  return null;
}

export function saveEntityFeedback({
  domain, entityId, text, title = null, company = null, source = null, metadata = null,
}) {
  const parsed = parseEntityFeedback(text, { domain, company });
  if (!parsed) return null;
  const event = recordFeedbackEvent({
    domain,
    entityId,
    signal: parsed.signal,
    subjectType: company ? "company" : "item",
    subjectValue: company || title,
    rawText: text,
    metadata: { title, company, source, ...(metadata || {}) },
  });
  const alreadyActive = parsed.durableRule && listFeedbackRules(
    parsed.durableRule.domain,
    parsed.durableRule.kind,
  ).some((rule) => rule.keyword === parsed.durableRule.keyword);
  const proposal = parsed.durableRule && !alreadyActive
    ? createFeedbackRuleProposal({ ...parsed.durableRule, sourceEventId: event.id })
    : null;
  return { ...parsed, event, proposal, alreadyActive };
}

export function proposeExplicitRule(rule) {
  return createFeedbackRuleProposal({
    domain: rule.domain,
    kind: rule.kind,
    keyword: rule.keyword,
    instruction: rule.instruction,
  });
}

export function ruleProposalKeyboard(proposal) {
  return {
    inline_keyboard: [[
      { text: "적용", callback_data: `f:ap:${proposal.id}` },
      { text: "취소", callback_data: `f:cn:${proposal.id}` },
    ]],
  };
}

export function ruleProposalMessage(proposal, impact = null) {
  return [
    "이 규칙을 앞으로 계속 적용할까요?",
    "",
    `범위: ${proposal.domain === "housing" ? "주택" : proposal.domain === "jobs" ? "채용" : proposal.domain}`,
    `규칙: ${proposal.instruction}`,
    impact ? `영향: ${impact}` : null,
  ].filter(Boolean).join("\n");
}
