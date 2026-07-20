import {
  createFeedbackRuleProposal,
  listFeedbackRules,
  recordFeedbackEvent,
} from "../../core/state.mjs";

const positiveWords = /좋|괜찮|마음에|맘에|끌려|유용|유망|나아\s*보|제일\s*나아|관심(?:이)?\s*가|지원해?\s*볼\s*만|해\s*볼\s*만|추천[ \t]*좋/;
const negativeWords = /별로|관심[ \t]*없|안[ \t]*끌|안\s*좋|괜찮(?:지)?\s*않|맘에[ \t]*안|마음에[ \t]*(?:안|들지\s*않)|추천[ \t]*제외|안[ \t]*볼|패스|거를|싫|아닌(?:\s*(?:것|거))?\s*같|아닌\s*듯|아닌데|안\s*맞|메리트\s*없|미묘/;
const appliedWords = /지원했|지원함|지원\s*완료|신청했|신청함|신청\s*완료|접수했|접수\s*완료|넣었/;
const durableWords = /앞으로|앞으론|다음부터|다음엔|계속|항상|다시는|영구|더는|더\s*이상|이제.*(?:빼|제외|안\s*보여|안\s*나오)|이[ \t]*회사.*(?:빼|제외|안\s*보여|안\s*나오)|회사.*(?:빼|제외|안\s*보여|안\s*나오)/;
const mixedWords = /(?:지만|그런데|근데|반면|그래도|다만|좋.*(?:별로|아쉽|싫)|(?:별로|아쉽|싫).*좋)/;

export function hasFeedbackIntent(text) {
  const value = String(text || "").trim();
  return appliedWords.test(value) || positiveWords.test(value) || negativeWords.test(value) || durableWords.test(value);
}

export function parseEntityFeedback(text, { domain, company = null } = {}) {
  const value = String(text || "").trim();
  if (!value) return null;
  if (appliedWords.test(value)) return { signal: "applied", durableRule: null };
  if (mixedWords.test(value) && positiveWords.test(value) && negativeWords.test(value)) return null;
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
  domain, entityId, text, title = null, company = null, source = null, metadata = null, sourceKey = null,
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
    sourceKey,
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

export function saveInterpretedFeedback({
  domain, entityId, text, interpretation, title = null, company = null, source = null,
  metadata = null, ruleExists = null, sourceKey = null,
}) {
  const signal = interpretation.intent === "durable_rule" ? "negative" : interpretation.intent;
  if (!["positive", "negative", "mixed"].includes(signal)) return null;
  const subjectType = interpretation.scope === "company" && company ? "company" : interpretation.scope || "item";
  const subjectValue = subjectType === "company"
    ? company
    : interpretation.keywords?.[0] || title;
  const event = recordFeedbackEvent({
    domain,
    entityId,
    signal,
    subjectType,
    subjectValue,
    rawText: text,
    metadata: {
      title, company, source, ...(metadata || {}),
      interpretation: {
        scope: interpretation.scope,
        strength: interpretation.strength,
        preference: interpretation.preference,
        keywords: interpretation.keywords,
        aspects: interpretation.aspects || [],
        confidence: interpretation.confidence,
        reason: interpretation.reason,
        source: interpretation.source,
        model: interpretation.model || null,
        promptVersion: interpretation.promptVersion || null,
        schemaVersion: interpretation.schemaVersion || null,
      },
    },
    sourceKey,
  });
  let durableRule = null;
  if (interpretation.intent === "durable_rule") {
    if (domain === "jobs" && interpretation.ruleKind === "exclude_company" && company) {
      durableRule = { domain, kind: "exclude_company", keyword: company, instruction: `${company} 회사 제외` };
    }
    if (domain === "housing" && interpretation.ruleKind === "exclude_keyword" && interpretation.ruleKeyword) {
      durableRule = {
        domain, kind: "exclude_keyword", keyword: interpretation.ruleKeyword,
        instruction: `${interpretation.ruleKeyword} 제외`,
      };
    }
  }
  const alreadyActive = durableRule && (ruleExists
    ? ruleExists(durableRule)
    : listFeedbackRules(durableRule.domain, durableRule.kind).some((rule) => rule.keyword === durableRule.keyword));
  const proposal = durableRule && !alreadyActive
    ? createFeedbackRuleProposal({ ...durableRule, sourceEventId: event.id })
    : null;
  return { signal, event, durableRule, proposal, alreadyActive, interpretation };
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
