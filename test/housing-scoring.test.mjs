import assert from "node:assert/strict";
import test from "node:test";

import { normalizeAssessment, scoreLabel } from "../src/apps/housing/scoring.mjs";

const breakdown = {
  housing_value: { score: 32, reasons: ["교통"] },
  selection_chance: { score: 18, reasons: ["공급량"] },
  execution: { score: 25, reasons: ["접수 여유"] },
};

test("hides the total score until eligibility and evidence are complete", () => {
  const result = normalizeAssessment({
    eligibility: "uncertain",
    score: 99,
    evidence_status: "partial",
    evidence_gaps: ["소득 기준"],
    critical_unknowns: ["소득 기준"],
    value_breakdown: breakdown,
  });

  assert.equal(result.score, null);
  assert.equal(scoreLabel(result), "자격 확인 필요");
});

test("computes the total from bounded components only for a confirmed candidate", () => {
  const result = normalizeAssessment({
    eligibility: "yes",
    score: 1,
    evidence_status: "complete",
    critical_unknowns: [],
    value_breakdown: {
      housing_value: { subscores: {
        transit_access: { score: 99, reasons: ["교통 근거"] },
        cost_value: { score: 10, reasons: ["비용 근거"] },
        area_quality: { score: 10, reasons: ["면적 근거"] },
        tenure_usefulness: { score: 5, reasons: ["입주 근거"] },
      } },
      selection_chance: { subscores: {
        target_priority_fit: { score: 15, reasons: ["계층 근거"] },
        supply_competition: { score: 10, reasons: ["공급 근거"] },
        residency_subscription: { score: 5, reasons: ["거주 근거"] },
      } },
      execution: { subscores: {
        application_timing: { score: 5, reasons: ["기간 근거"] },
        condition_clarity: { score: 10, reasons: ["조건 근거"] },
        application_readiness: { score: 0, reasons: [] },
      } },
    },
  });

  assert.equal(result.score, 85);
  assert.equal(result.value_breakdown.housing_value.score, 40);
  assert.equal(result.value_breakdown.housing_value.subscores.transit_access.score, 15);
  assert.equal(scoreLabel(result), "추천 85점");
});

test("downgrades a claimed yes when a critical condition is unknown", () => {
  const result = normalizeAssessment({
    eligibility: "yes",
    evidence_status: "complete",
    critical_unknowns: ["공급계층"],
    value_breakdown: breakdown,
  });

  assert.equal(result.eligibility, "uncertain");
  assert.equal(result.score, null);
});

test("does not trust a complete claim while retrieval gaps remain", () => {
  const result = normalizeAssessment({
    eligibility: "yes",
    evidence_status: "complete",
    evidence_gaps: ["PDF 다운로드 실패"],
    critical_unknowns: [],
    value_breakdown: breakdown,
  });

  assert.equal(result.evidence_status, "partial");
  assert.equal(result.score, null);
});

test("drops arbitrary model fields outside the persisted assessment schema", () => {
  const result = normalizeAssessment({
    eligibility: "uncertain",
    evidence_status: "partial",
    leaked_profile: { birth_date: "1990-01-02" },
  });
  assert.equal("leaked_profile" in result, false);
});

test("awards no component points without an evidence reason", () => {
  const result = normalizeAssessment({
    eligibility: "yes",
    evidence_status: "complete",
    critical_unknowns: [],
    value_breakdown: {
      housing_value: { score: 40, reasons: [] },
      selection_chance: { score: 30 },
      execution: { subscores: { application_timing: { score: 27, reasons: ["접수기간 확인"] } } },
    },
  });
  assert.equal(result.score, 10);
});

test("normalizes primitive review arrays and drops nested arbitrary values", () => {
  const result = normalizeAssessment({
    eligibility: "uncertain",
    cautions: [37_000_000, { secret: "nested" }],
    evidence: [51_000_000, ["nested"]],
  });
  assert.deepEqual(result.cautions, ["37000000"]);
  assert.deepEqual(result.evidence, ["51000000"]);
});
