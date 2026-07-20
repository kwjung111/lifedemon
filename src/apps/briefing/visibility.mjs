import { listFeedbackRules } from "../../core/state.mjs";
import { db as housingDb, listHousingRules } from "../../db.mjs";
import { sendMessage } from "../../telegram.mjs";
import { normalizeCompanyName } from "../jobs/company-verification.mjs";
import { canonicalJobKey, jobDb } from "../jobs/db.mjs";
import { jobReportSnapshot } from "../jobs/report.mjs";
import { housingReportSnapshot } from "../../report.mjs";

const genericWords = new Set([
  "공고", "채용", "주택", "회사", "추천", "목록", "왜", "안", "보여", "보이지", "빠졌어", "빠졌지",
]);

function normalized(value) {
  return String(value || "").toLowerCase().replace(/주식회사|\(주\)|㈜/g, "").replace(/[^0-9a-z가-힣]/g, "");
}

function queryTokens(value) {
  return String(value || "").toLowerCase().split(/[^0-9a-z가-힣]+/)
    .filter((token) => token.length >= 2 && !genericWords.has(token))
    .map(normalized).filter(Boolean);
}

function matchScore(row, query, domain) {
  const needle = normalized(query);
  if (!needle) return 0;
  const fields = domain === "jobs"
    ? [row.company, row.title, row.source]
    : [row.title, row.source, row.location];
  const values = fields.map(normalized).filter(Boolean);
  if (values.some((value) => value === needle)) return 120;
  if (values.some((value) => value.includes(needle))) return 100;
  if (values.some((value) => value.length >= 2 && needle.includes(value))) return 85;
  const tokens = queryTokens(query);
  return tokens.reduce((score, token) => score + (values.some((value) => value.includes(token)) ? 20 : 0), 0);
}

function jobFacts() {
  return jobDb.prepare(`
    SELECT p.*, ja.status AS application_status,
           COALESCE(ja.recommendation_hidden, 0) AS recommendation_hidden,
           a.decision, a.result_json, a.content_hash AS assessed_content_hash,
           q.state AS queue_state, q.last_error AS queue_error
    FROM job_postings p
    LEFT JOIN job_applications ja ON ja.posting_id=p.id
    LEFT JOIN job_assessments a ON a.posting_id=p.id
    LEFT JOIN job_filter_queue q ON q.posting_id=p.id
    ORDER BY p.active DESC, p.last_seen DESC
  `).all();
}

function housingFacts() {
  return housingDb.prepare(`
    SELECT n.*, a.status AS application_status,
           COALESCE(a.recommendation_hidden, 0) AS recommendation_hidden,
           r.eligibility AS ai_eligibility, r.status AS ai_status,
           r.result_json AS ai_result_json,
           q.state AS queue_state, q.last_error AS queue_error
    FROM notices n
    LEFT JOIN applications a ON a.notice_id=n.id
    LEFT JOIN notice_reviews r ON r.notice_id=n.id
    LEFT JOIN review_queue q ON q.notice_id=n.id
    ORDER BY n.active DESC, n.last_seen DESC
  `).all();
}

function rankedMatches(rows, query, domain) {
  const groups = new Map();
  for (const row of rows) {
    const score = matchScore(row, query, domain);
    if (!score) continue;
    const key = domain === "jobs" ? canonicalJobKey(row) : normalized(row.title);
    const previous = groups.get(key);
    if (!previous || score > previous.score) groups.set(key, { row, score });
  }
  return [...groups.values()].sort((left, right) => right.score - left.score).slice(0, 6);
}

function parseSummary(value) {
  try {
    const parsed = JSON.parse(value || "null");
    return String(parsed?.summary || parsed?.reasons?.[0] || "").trim();
  } catch { return ""; }
}

function result(domain, row, reason, action, code, extra = {}) {
  return {
    status: "explained", domain, code, reason, action,
    item: {
      index: 1, id: row.id, domain, title: row.title,
      company: row.company || null, source: row.source || null,
    },
    label: domain === "jobs" ? `${row.company} — ${row.title}` : `[${row.source}] ${row.title}`,
    url: row.url || null,
    ...extra,
  };
}

function explainJob(row, rows) {
  const key = canonicalJobKey(row);
  const group = rows.filter((candidate) => canonicalJobKey(candidate) === key);
  const applied = group.find((candidate) => candidate.application_status === "applied");
  if (applied) return result("jobs", row,
    "이미 지원 완료로 저장되어 추천에서는 제외되고 지원 이력에서 추적 중입니다.",
    "/job_status에서 진행 상태를 확인할 수 있어요. 잘못 저장됐다면 이 메시지에 ‘이거 취소해’라고 답장하세요.",
    "applied");
  if (group.some((candidate) => candidate.recommendation_hidden || candidate.application_status === "ignored")) {
    return result("jobs", row,
      "‘관심없어’ 또는 부정 피드백으로 이 공고가 추천에서 숨겨져 있습니다.",
      "다시 추천에 넣으려면 이 메시지에 ‘관심없음 취소’라고 답장하세요.",
      "ignored");
  }
  const companyRule = listFeedbackRules("jobs", "exclude_company")
    .find((rule) => normalizeCompanyName(rule.keyword) === normalizeCompanyName(row.company));
  if (companyRule) return result("jobs", row,
    `영구 제외 규칙 J${companyRule.id}이 적용 중입니다: ${companyRule.instruction}`,
    "‘피드백 규칙 보여줘’에서 해당 J 번호를 삭제하면 이후 추천에 다시 포함될 수 있어요.",
    "durable_rule");
  if (!group.some((candidate) => candidate.active)) return result("jobs", row,
    "수집처에서 더 이상 진행 중인 공고로 확인되지 않아 비활성 처리됐습니다.",
    "원문 링크에서 재오픈 여부를 확인해 주세요.", "inactive");

  const snapshot = jobReportSnapshot({ limit: 1000 });
  const shownIndex = snapshot.selected.findIndex((candidate) => canonicalJobKey(candidate) === key);
  if (shownIndex >= 0) {
    const shown = snapshot.selected[shownIndex];
    if (shown.id !== row.id) return result("jobs", row,
      `같은 회사·직무의 중복 공고가 있어 ${shown.source} 공고 하나만 대표로 노출 중입니다.`,
      `현재 전체 추천의 ${shownIndex + 1}번째에 있습니다.`, "duplicate", { shownIndex: shownIndex + 1 });
    return result("jobs", row,
      shownIndex < 3 ? "제외된 공고가 아니라 현재 상위 추천에 포함돼 있습니다."
        : "제외된 공고가 아니라 현재 전체 추천의 다음 페이지에 있습니다.",
      `현재 전체 추천의 ${shownIndex + 1}번째입니다. ‘채용 더 보여줘’로 확인할 수 있어요.`,
      "visible", { shownIndex: shownIndex + 1 });
  }

  const excluded = group.find((candidate) => candidate.decision === "exclude");
  if (excluded) return result("jobs", row,
    `현재 필터 판정이 제외입니다${parseSummary(excluded.result_json) ? `: ${parseSummary(excluded.result_json)}` : "."}`,
    "기업 검증·직무 조건이 바뀌면 다음 필터링에서 다시 평가됩니다.", "assessment_exclude");
  const failed = group.find((candidate) => candidate.queue_state === "error");
  if (failed) return result("jobs", row,
    `채용 적합도 평가가 실패해 추천에 올리지 못했습니다: ${String(failed.queue_error || "원인 확인 필요").slice(0, 180)}`,
    "다음 채용 수집 때 재시도됩니다.", "filter_error");
  if (group.some((candidate) => ["pending", "reviewing"].includes(candidate.queue_state))) return result("jobs", row,
    "신규·변경 공고의 기업 검증 또는 적합도 평가가 아직 진행 중입니다.",
    "평가가 끝나면 조건을 통과한 경우 자동으로 추천에 들어옵니다.", "pending_review");
  return result("jobs", row,
    "현재 프로필·기업 검증 기준과 일치하는 최신 적합 판정이 없어 추천에 포함되지 않았습니다.",
    "다음 채용 필터링 후 다시 확인해 주세요.", "not_assessed");
}

function explainHousing(row) {
  if (row.application_status === "applied") return result("housing", row,
    "이미 신청 완료로 저장되어 추천에서는 제외되고 지원 이력에서 추적 중입니다.",
    "/housing_status에서 진행 상태를 확인할 수 있어요. 잘못 저장됐다면 이 메시지에 ‘이거 취소해’라고 답장하세요.",
    "applied");
  if (row.recommendation_hidden || row.application_status === "ignored") return result("housing", row,
    "‘관심없어’ 또는 부정 피드백으로 이 공고가 추천에서 숨겨져 있습니다.",
    "다시 추천에 넣으려면 이 메시지에 ‘관심없음 취소’라고 답장하세요.", "ignored");
  if (!row.active) return result("housing", row,
    "공식 수집 목록에서 더 이상 활성 공고로 확인되지 않아 종료 처리됐습니다.",
    "원문 링크에서 재공고 여부를 확인해 주세요.", "inactive");
  if (row.verdict === "exclude") {
    const housingRule = listHousingRules().find((rule) =>
      normalized(`${row.title} ${row.raw_text}`).includes(normalized(rule.keyword))
    );
    if (housingRule) return result("housing", row,
      `주택 제외 규칙 H${housingRule.id}과 일치해 초기 분류에서 제외됐습니다: ${housingRule.instruction}`,
      "‘피드백 규칙 보여줘’에서 해당 H 번호를 삭제하면 다음 수집부터 다시 평가됩니다.",
      "durable_rule");
    return result("housing", row,
      "초기 공고 분류에서 현재 주거 추천 대상이 아닌 것으로 제외됐습니다.",
      "공고 조건이 변경되면 다음 수집에서 다시 분류됩니다.", "initial_exclude");
  }

  const snapshot = housingReportSnapshot({ limit: 1000 });
  const shownIndex = snapshot.candidates.findIndex((candidate) => candidate.id === row.id);
  if (shownIndex >= 0) return result("housing", row,
    shownIndex < 3 ? "제외된 공고가 아니라 현재 상위 추천에 포함돼 있습니다."
      : "제외된 공고가 아니라 현재 전체 추천의 다음 페이지에 있습니다.",
    `현재 전체 추천의 ${shownIndex + 1}번째입니다. ‘주택 더 보여줘’로 확인할 수 있어요.`,
    "visible", { shownIndex: shownIndex + 1 });
  const duplicateIndex = snapshot.candidates.findIndex((candidate) => normalized(candidate.title) === normalized(row.title));
  if (duplicateIndex >= 0) return result("housing", row,
    "동일 제목 공고가 여러 출처에 있어 대표 공고 하나만 노출 중입니다.",
    `대표 공고는 현재 전체 추천의 ${duplicateIndex + 1}번째입니다.`, "duplicate");
  if (["selected", "not_selected"].includes(row.application_status)) return result("housing", row,
    row.application_status === "selected" ? "선정 결과가 기록되어 지원 결과 이력으로 이동했습니다."
      : "미선정 결과가 기록되어 진행 중 지원 목록에서 결과 이력으로 이동했습니다.",
    "/housing_status에서 결과 이력을 확인할 수 있어요.", row.application_status);
  const today = snapshot.today;
  if (row.apply_end && row.apply_end < today) return result("housing", row,
    `신청 마감일 ${row.apply_end}이 지나 신규 추천에서 빠졌습니다.`,
    "이미 신청한 공고라면 ‘신청했어’로 지원 이력에 별도 기록할 수 있어요.", "expired");
  if (row.ai_eligibility === "no") return result("housing", row,
    `현재 사용자 조건 기준으로 신청 대상이 아닌 것으로 판정됐습니다${parseSummary(row.ai_result_json) ? `: ${parseSummary(row.ai_result_json)}` : "."}`,
    "조건이나 공식 공고 내용이 바뀌면 다시 평가됩니다.", "ineligible");
  if (row.ai_status === "closed") return result("housing", row,
    "공식 근거에서 접수가 종료된 공고로 판정됐습니다.",
    "재공고가 올라오면 새 공고로 다시 수집됩니다.", "closed");
  if (row.queue_state === "error") return result("housing", row,
    `공식 자료 분석이 실패해 추천에 올리지 못했습니다: ${String(row.queue_error || "원인 확인 필요").slice(0, 180)}`,
    "다음 주택 분석 때 재시도됩니다.", "review_error");
  if (["pending", "reviewing"].includes(row.queue_state)) return result("housing", row,
    "공식 조건과 사용자 적합도 분석이 아직 진행 중입니다.",
    "분석이 끝나면 조건을 통과한 경우 자동으로 추천에 들어옵니다.", "pending_review");
  return result("housing", row,
    "현재 추천 필터의 필수 조건을 충족하지 않아 목록에 포함되지 않았습니다.",
    "공고명과 공식 조건을 다시 확인해 주세요.", "filtered");
}

export function explainRecommendationVisibility({ domain = null, query = "", target = null } = {}) {
  const jobRows = domain === "housing" ? [] : jobFacts();
  const housingRows = domain === "jobs" ? [] : housingFacts();
  if (target?.id) {
    const targetDomain = target.domain || domain;
    const row = targetDomain === "jobs"
      ? jobRows.find((item) => item.id === target.id)
      : housingRows.find((item) => item.id === target.id);
    if (row) return targetDomain === "jobs" ? explainJob(row, jobRows) : explainHousing(row);
  }
  const matches = [
    ...rankedMatches(jobRows, query, "jobs").map((match) => ({ ...match, domain: "jobs" })),
    ...rankedMatches(housingRows, query, "housing").map((match) => ({ ...match, domain: "housing" })),
  ].sort((left, right) => right.score - left.score);
  if (!matches.length) return { status: "not_found", query };
  const top = matches[0];
  const close = matches.filter((match) => match.score >= top.score - 10);
  if (close.length > 1) return {
    status: "ambiguous", query,
    items: close.slice(0, 5).map((match, index) => ({
      index: index + 1, id: match.row.id, domain: match.domain,
      title: match.row.title, company: match.row.company || null, source: match.row.source || null,
    })),
  };
  return top.domain === "jobs" ? explainJob(top.row, jobRows) : explainHousing(top.row);
}

function formatExplanation(explanation) {
  if (explanation.status === "not_found") {
    return `🔎 ‘${String(explanation.query || "해당 공고").slice(0, 100)}’와 연결되는 수집 기록을 찾지 못했어요.\n회사명이나 공고 제목의 특징적인 부분을 조금 더 정확히 알려 주세요.`;
  }
  if (explanation.status === "ambiguous") {
    const lines = explanation.items.map((item) => `${item.index}. ${item.domain === "jobs" ? `${item.company} — ` : `[${item.source}] `}${item.title}`);
    return `🔎 비슷한 공고가 여러 개예요.\n\n${lines.join("\n")}\n\n이 메시지에 ‘2번 왜 빠졌어?’처럼 답장해 주세요.`;
  }
  return [
    "🔎 추천 노출 상태",
    explanation.label,
    "",
    `이유: ${explanation.reason}`,
    explanation.action,
    explanation.url || null,
  ].filter(Boolean).join("\n");
}

export async function sendRecommendationExplanation(options, { send = sendMessage } = {}) {
  const explanation = explainRecommendationVisibility(options);
  const items = explanation.status === "ambiguous" ? explanation.items
    : explanation.item ? [explanation.item] : [];
  await send(formatExplanation(explanation), {}, items.length ? {
    context: {
      domain: explanation.domain || options.domain || null,
      kind: explanation.status === "ambiguous" ? "visibility_choices" : "visibility",
      items,
    },
  } : {});
  return explanation;
}
