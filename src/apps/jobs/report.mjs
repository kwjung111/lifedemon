import { companyVerificationFingerprint, loadAuthorizedCompanyVerifications } from "./company-verification.mjs";
import { jobAssessmentSummary } from "./db.mjs";
import { jobProfileFingerprint, loadJobProfile } from "./profile.mjs";
import { sendMessage } from "../../telegram.mjs";

const sourceLabel = { remember: "리멤버", wanted: "원티드", jobkorea: "잡코리아" };

function assessmentFor(row) {
  try { return JSON.parse(row.result_json); } catch { return {}; }
}

export function formatJobReport(collection = [], { limit = 10 } = {}) {
  const profile = loadJobProfile();
  const verifications = loadAuthorizedCompanyVerifications();
  const summary = jobAssessmentSummary(jobProfileFingerprint(profile), companyVerificationFingerprint(verifications), limit);
  const collectionLine = collection.length
    ? collection.map((entry) => `${sourceLabel[entry.source] || entry.source} ${entry.error ? "오류" : entry.count}`).join(" · ")
    : "수집 결과 없음";
  const pass = summary.counts.pass || 0;
  const uncertain = summary.counts.uncertain || 0;
  const excluded = summary.counts.exclude || 0;
  const lines = [
    `💼 채용 공고 · ${new Date().toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" })}`,
    `수집: ${collectionLine}`,
    `판정: 적합 ${pass} · 확인 ${uncertain} · 제외 ${excluded}`,
  ];
  if (!summary.selected.length) {
    lines.push("", "현재 조건을 통과한 공고가 없습니다.");
    if (!verifications.size) lines.push("회사 검증 데이터가 아직 없어 엄격 필터가 모두 제외 중입니다.");
  } else {
    lines.push("", "오늘 확인할 공고");
    summary.selected.forEach((row, index) => {
      const result = assessmentFor(row);
      lines.push("", `${index + 1}. ${row.decision === "pass" ? "✅ 적합" : "⚠️ 확인"} · ${sourceLabel[row.source] || row.source}`);
      lines.push(`${row.company} — ${row.title}`.slice(0, 220));
      if (result.summary) lines.push(String(result.summary).slice(0, 260));
      lines.push(row.url);
    });
  }
  if (summary.failures.length) lines.push("", `필터 오류 ${summary.failures.length}건: ${summary.failures[0].slice(0, 140)}`);
  return lines.join("\n").slice(0, 4090);
}

export async function sendJobReport(collection = [], options = {}) {
  return sendMessage(formatJobReport(collection, options));
}
