import {
  decideFeedbackRuleProposal,
  disableFeedbackRule,
  feedbackRuleProposalForEvent,
  latestFeedbackEvent,
  revertFeedbackEvent,
  cancelRemindersForEntity,
} from "../../core/state.mjs";
import {
  disableHousingRule,
  restoreHousingApplicationStatus,
  restoreHousingRecommendationHidden,
} from "../../db.mjs";
import { restoreJobApplicationStatus, restoreJobRecommendationHidden } from "../jobs/db.mjs";

function metadataFor(event) {
  try { return JSON.parse(event.metadata_json || "{}"); } catch { return {}; }
}

function undoRuleFor(event) {
  const proposal = feedbackRuleProposalForEvent(event.id);
  if (!proposal) return false;
  if (proposal.status === "proposed") return decideFeedbackRuleProposal(proposal.id, "rejected");
  if (proposal.status !== "approved" || !proposal.target_ref) return false;
  const [store, rawId] = proposal.target_ref.split(":");
  if (store === "feedback") return disableFeedbackRule(Number(rawId));
  if (store === "housing") return disableHousingRule(Number(rawId));
  return false;
}

export function undoLatestFeedback({ domain = null, entityId = null, text = null } = {}) {
  const event = latestFeedbackEvent({ domain, entityId });
  if (!event) return null;
  const metadata = metadataFor(event);
  if (["applied", "ignored", "negative"].includes(event.signal)) {
    const previous = metadata.previousApplicationStatus || null;
    if (event.domain === "jobs") restoreJobApplicationStatus(event.entity_id, previous);
    if (event.domain === "housing") restoreHousingApplicationStatus(event.entity_id, previous);
  }
  if (["ignored", "negative", "positive"].includes(event.signal)) {
    const previousHidden = Boolean(metadata.previousRecommendationHidden);
    if (event.domain === "jobs") restoreJobRecommendationHidden(event.entity_id, previousHidden);
    if (event.domain === "housing") restoreHousingRecommendationHidden(event.entity_id, previousHidden);
  }
  if (event.signal === "applied") {
    if (event.domain === "housing") cancelRemindersForEntity("housing", `${event.entity_id}:`);
    if (event.domain === "jobs") cancelRemindersForEntity("jobs", `${event.entity_id}:`);
  }
  const ruleDisabled = undoRuleFor(event);
  if (!revertFeedbackEvent(event.id, text)) return null;
  return { event, metadata, ruleDisabled };
}

export function formatUndoResult(result) {
  if (!result) return "되돌릴 최근 피드백이 없습니다.";
  const subject = result.metadata.company || result.metadata.title || "해당 공고";
  return `↩️ 최근 피드백을 취소했습니다: ${subject}${result.ruleDisabled ? "\n연결된 영구 제외 규칙도 해제했습니다." : ""}`;
}
