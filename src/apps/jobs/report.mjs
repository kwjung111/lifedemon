import { companyVerificationFingerprint, loadAuthorizedCompanyVerifications } from "./company-verification.mjs";
import { appliedJobs, getJobSetting, jobAssessmentSummary, saveJobDigestItems } from "./db.mjs";
import { jobProfileFingerprint, loadJobProfile } from "./profile.mjs";
import { sendMessage } from "../../telegram.mjs";
import { listFeedbackRules, recentFeedbackEvents } from "../../core/state.mjs";

const sourceLabel = { remember: "리멤버", wanted: "원티드", jobkorea: "잡코리아" };
const telegramLimit = 4000;
function assessmentFor(row) { try { return JSON.parse(row.result_json); } catch { return {}; } }
const escapeHtml = (value) => String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const link = (url) => `<a href="${escapeHtml(url)}">링크</a>`;

function healthTime(value) {
  if (!value) return "아직 없음";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "확인 필요";
  return date.toLocaleString("ko-KR", { timeZone: "Asia/Seoul", hour12: false });
}

function buildJobReportPages(collection = [], { limit = 100, filtering = [], verification = null } = {}) {
  const profile = loadJobProfile();
  const verifications = loadAuthorizedCompanyVerifications();
  const excludedCompanies = listFeedbackRules("jobs", "exclude_company").map((rule) => rule.keyword);
  const preferredCompanies = recentFeedbackEvents(100)
    .filter((event) => event.domain === "jobs" && event.signal === "positive" && event.subject_type === "company")
    .map((event) => event.subject_value);
  const summary = jobAssessmentSummary(
    jobProfileFingerprint(profile),
    companyVerificationFingerprint(verifications),
    limit,
    { excludedCompanies, preferredCompanies },
  );
  const applications = appliedJobs();
  const collectionLine = collection.length ? collection.map((entry) => `${sourceLabel[entry.source] || entry.source} ${entry.error ? "오류" : entry.count}`).join(" · ") : "수집 결과 없음";
  const newCount = collection.reduce((total, item) => total + (item.newCount || 0), 0);
  const changedCount = collection.reduce((total, item) => total + (item.changedCount || 0), 0);
  const deactivatedCount = collection.reduce((total, item) => total + (item.deactivatedCount || 0), 0);
  const collectionErrors = collection.filter((item) => item.error).length;
  const filteringErrors = filtering.filter((item) => item.error).length;
  const verificationErrors = verification?.results?.filter((item) => item.error).length || 0;
  const header = [
    `💼 채용 공고 · ${new Date().toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" })}`,
    `수집: ${collectionLine}`,
    `품질: 신규 ${newCount} · 변경 ${changedCount} · 종료 ${deactivatedCount} · 오류 ${collectionErrors + filteringErrors + verificationErrors}`,
    `마지막 정상 수집: ${healthTime(getJobSetting("job_collection_last_success_at"))}`,
    `판정: 적합 ${summary.counts.pass || 0} · 확인 ${summary.counts.uncertain || 0} · 제외 ${summary.counts.exclude || 0}`,
    `지원 추적: ${applications.length}건`,
    "답장 예: ‘2번 지원했어’, ‘2번 별로야’, ‘2번 이 회사는 앞으로 빼’",
  ];
  if (!summary.selected.length) {
    header.push("", "현재 조건을 통과한 공고가 없습니다.");
    if (!verifications.size) header.push("회사 검증 데이터가 아직 없어 엄격 필터가 모두 제외 중입니다.");
  } else header.push("", `오늘 확인할 공고 (${summary.selected.length}건)`);
  const entries = summary.selected.map((row, index) => {
    const result = assessmentFor(row);
    return ["", `${index + 1}. ${row.decision === "pass" ? "✅ 적합" : "⚠️ 확인"} · ${sourceLabel[row.source] || row.source}`,
      escapeHtml(`${row.company} — ${row.title}`.slice(0, 220)), result.summary ? escapeHtml(String(result.summary).slice(0, 260)) : null, link(row.url)].filter(Boolean).join("\n");
  });
  if (summary.failures.length) header.push("", `필터 오류 ${summary.failures.length}건: ${summary.failures[0].slice(0, 140)}`);
  const page = { text: header.join("\n"), items: [] };
  for (const [offset, entry] of entries.entries()) {
    const item = { index: offset + 1, id: summary.selected[offset].id };
    if (`${page.text}\n${entry}`.length > telegramLimit - 80) break;
    page.text = `${page.text}\n${entry}`;
    page.items.push(item);
  }
  const remaining = entries.length - page.items.length;
  if (remaining > 0) page.text = `${page.text}\n\n외 ${remaining}건은 /jobs에서 다음 조회 시 확인할 수 있습니다.`;
  return [page];
}

export function formatJobReportPages(collection = [], options = {}) { return buildJobReportPages(collection, options).map((page) => page.text); }
export function formatJobReport(collection = [], options = {}) { return formatJobReportPages(collection, options)[0]; }
export async function sendJobReport(collection = [], options = {}) {
  const sent = [];
  const pages = buildJobReportPages(collection, options);
  for (const [pageIndex, page] of pages.entries()) {
    const context = { domain: "jobs", kind: "digest", items: page.items };
    const message = await sendMessage(page.text, {
      parse_mode: "HTML",
      ...(page.items.length ? {
        reply_markup: {
          inline_keyboard: page.items.map((item) => [
            { text: `${item.index}번 지원했어`, callback_data: `j:ap:${item.id}` },
          ]),
        },
      } : {}),
    }, {
      dedupeKey: options.deliveryKey ? `${options.deliveryKey}:${pageIndex + 1}` : null,
      context,
    });
    if (message?.message_id) saveJobDigestItems(message.message_id, page.items);
    sent.push(message);
  }
  return sent;
}

export function formatJobApplicationStatus() {
  const jobs = appliedJobs();
  if (!jobs.length) return "현재 지원 추적 중인 채용공고가 없습니다.";
  const lines = jobs.map((job, index) => [
    `${index + 1}. ${escapeHtml(`${job.company} — ${job.title}`)}`,
    job.applied_at ? `지원일 ${new Date(job.applied_at).toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" })}` : "지원일 확인 필요",
    link(job.url),
  ].join("\n"));
  return `📌 채용 지원 진행 중 (${jobs.length}건)\n\n${lines.join("\n\n")}`;
}

export async function sendJobApplicationStatus() {
  return sendMessage(formatJobApplicationStatus(), { parse_mode: "HTML" });
}
