import { saveApplicationResult, setHousingRecommendationFeedback } from "../db.mjs";

const [noticeId, outcome, housingName = "", cutoffPriority = "", cutoffScore = "", supplyUnits = "", preference = ""] = process.argv.slice(2);
if (!noticeId || !["selected", "not_selected", "waitlisted", "unknown"].includes(outcome)) {
  throw new Error("usage: record-housing-result NOTICE_ID selected|not_selected|waitlisted|unknown [HOUSING_NAME] [CUTOFF_PRIORITY] [CUTOFF_SCORE] [SUPPLY_UNITS] [PREFERENCE]");
}
const numeric = (value) => value === "" ? null : Number(value);
const result = saveApplicationResult(noticeId, {
  stage: "document",
  outcome,
  housingName: housingName || null,
  cutoffPriority: numeric(cutoffPriority),
  cutoffScore: numeric(cutoffScore),
  supplyUnits: numeric(supplyUnits),
  note: "사용자 제공 지원 결과",
  source: "admin",
  checkedAt: new Date().toISOString(),
});
if (preference) setHousingRecommendationFeedback(preference);
console.log(JSON.stringify({ result, preference: preference || null }, null, 2));
