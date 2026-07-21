import {
  createFeedbackRuleProposal,
  listFeedbackRules,
  recordFeedbackEvent,
} from "../../core/state.mjs";

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
