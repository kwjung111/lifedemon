import { companyVerificationFingerprint, loadAuthorizedCompanyVerifications } from "./company-verification.mjs";
import { jobAssessmentSummary } from "./db.mjs";
import { jobProfileFingerprint, loadJobProfile } from "./profile.mjs";
import { sendMessage } from "../../telegram.mjs";

const sourceLabel = { remember: "리멤버", wanted: "원티드", jobkorea: "잡코리아" };
const telegramLimit = 4000;
function assessmentFor(row) { try { return JSON.parse(row.result_json); } catch { return {}; } }

export function formatJobReportPages(collection = [], { limit = 100 } = {}) {
  const profile = loadJobProfile();
  const verifications = loadAuthorizedCompanyVerifications();
  const summary = jobAssessmentSummary(jobProfileFingerprint(profile), companyVerificationFingerprint(verifications), limit);
  const collectionLine = collection.length ? collection.map((entry) => `${sourceLabel[entry.source] || entry.source} ${entry.error ? "오류" : entry.count}`).join(" · ") : "수집 결과 없음";
  const header = [
    `💼 채용 공고 · ${new Date().toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" })}`,
    `수집: ${collectionLine}`,
    `판정: 적합 ${summary.counts.pass || 0} · 확인 ${summary.counts.uncertain || 0} · 제외 ${summary.counts.exclude || 0}`,
  ];
  if (!summary.selected.length) {
    header.push("", "현재 조건을 통과한 공고가 없습니다.");
    if (!verifications.size) header.push("회사 검증 데이터가 아직 없어 엄격 필터가 모두 제외 중입니다.");
  } else header.push("", `오늘 확인할 공고 (${summary.selected.length}건)`);
  const entries = summary.selected.map((row, index) => {
    const result = assessmentFor(row);
    return ["", `${index + 1}. ${row.decision === "pass" ? "✅ 적합" : "⚠️ 확인"} · ${sourceLabel[row.source] || row.source}`,
      `${row.company} — ${row.title}`.slice(0, 220), result.summary ? String(result.summary).slice(0, 260) : null, row.url].filter(Boolean).join("\n");
  });
  if (summary.failures.length) header.push("", `필터 오류 ${summary.failures.length}건: ${summary.failures[0].slice(0, 140)}`);
  const pages = [header.join("\n")];
  for (const entry of entries) {
    const last = pages.length - 1;
    if (`${pages[last]}\n${entry}`.length > telegramLimit) pages.push(entry);
    else pages[last] = `${pages[last]}\n${entry}`;
  }
  return pages;
}

export function formatJobReport(collection = [], options = {}) { return formatJobReportPages(collection, options)[0]; }
export async function sendJobReport(collection = [], options = {}) {
  const sent = [];
  for (const page of formatJobReportPages(collection, options)) sent.push(await sendMessage(page));
  return sent;
}
