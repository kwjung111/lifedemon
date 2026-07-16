export const SCORE_RUBRIC = Object.freeze({
  housing_value: Object.freeze({ transit_access: 15, cost_value: 10, area_quality: 10, tenure_usefulness: 5 }),
  selection_chance: Object.freeze({ target_priority_fit: 15, supply_competition: 10, residency_subscription: 5 }),
  execution: Object.freeze({ application_timing: 10, condition_clarity: 10, application_readiness: 10 }),
});

const clamp = (value, max) => Math.max(0, Math.min(max, Math.round((Number(value) || 0) / 5) * 5));

function component(value, rubric) {
  const input = value && typeof value === "object" ? (value.subscores || value) : {};
  const subscores = Object.fromEntries(Object.entries(rubric).map(([key, max]) => {
    const raw = input[key] && typeof input[key] === "object" ? input[key] : {};
    const reasons = stringList(raw.reasons || (raw.reason ? [raw.reason] : []), 3);
    return [key, { score: reasons.length ? clamp(raw.score, max) : 0, max, reasons }];
  }));
  const reasons = Object.values(subscores).flatMap((item) => item.reasons).slice(0, 8);
  return {
    score: Object.values(subscores).reduce((sum, item) => sum + item.score, 0),
    max: Object.values(rubric).reduce((sum, item) => sum + item, 0),
    reasons,
    subscores,
  };
}

function stringList(value, limit = 10) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => ["string", "number", "boolean"].includes(typeof item))
    .map(String)
    .filter(Boolean)
    .slice(0, limit);
}

function needsList(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => item && typeof item === "object" && !Array.isArray(item)).map((item) => ({
    type: ["open", "search"].includes(item.type) ? item.type : "search",
    url: typeof item.url === "string" ? item.url : "",
    source: typeof item.source === "string" ? item.source : "",
    query: typeof item.query === "string" ? item.query : "",
    purpose: typeof item.purpose === "string" ? item.purpose : "",
  })).slice(0, 2);
}

export function normalizeAssessment(result) {
  if (!result || !["yes", "no", "uncertain"].includes(result.eligibility)) {
    throw new Error("invalid eligibility");
  }

  const criticalUnknowns = stringList(result.critical_unknowns);
  const evidenceGaps = stringList(result.evidence_gaps);
  const claimedEvidenceStatus = ["complete", "partial", "missing"].includes(result.evidence_status)
    ? result.evidence_status
    : "partial";
  const evidenceStatus = evidenceGaps.length ? "partial" : claimedEvidenceStatus;

  let eligibility = result.eligibility;
  if (eligibility === "yes" && criticalUnknowns.length) eligibility = "uncertain";

  const breakdown = {
    housing_value: component(result.value_breakdown?.housing_value, SCORE_RUBRIC.housing_value),
    selection_chance: component(result.value_breakdown?.selection_chance, SCORE_RUBRIC.selection_chance),
    execution: component(result.value_breakdown?.execution, SCORE_RUBRIC.execution),
  };
  const score = eligibility === "yes" && evidenceStatus === "complete"
    ? Object.values(breakdown).reduce((sum, item) => sum + item.score, 0)
    : null;

  return {
    eligibility,
    critical_unknowns: criticalUnknowns,
    evidence_status: evidenceStatus,
    evidence_gaps: evidenceGaps,
    value_breakdown: breakdown,
    score,
    status: String(result.status || "review"),
    summary: String(result.summary || "확인 필요"),
    supply_type: String(result.supply_type || "확인 필요"),
    region: String(result.region || "확인 필요"),
    apply_period: String(result.apply_period || "확인 필요"),
    target_conditions: String(result.target_conditions || "확인 필요"),
    income_assets: String(result.income_assets || "확인 필요"),
    costs: String(result.costs || "확인 필요"),
    units: String(result.units || "확인 필요"),
    needs: needsList(result.needs),
    cautions: stringList(result.cautions),
    evidence: stringList(result.evidence),
  };
}

export function scoreLabel(result) {
  if (!result) return null;
  if (result.eligibility === "no") return "신청 불가";
  if (result.eligibility !== "yes" || result.score == null) return "자격 확인 필요";
  return `추천 ${result.score}점`;
}
