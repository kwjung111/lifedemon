import { activeNotices, appliedNotices, saveDigestItems } from "./db.mjs";
import { sendMessage } from "./telegram.mjs";

const verdictLabel = { likely: "✅ 적합 가능성 높음", possible: "🟡 가능성 있음", review: "🔎 추가 확인" };
const sourceOrder = ["LH", "SH", "청년안심주택", "HUG", "마이홈"];

function dday(date) {
  if (!date) return "발표일 미확인";
  const target = new Date(`${date}T00:00:00+09:00`);
  const today = new Date();
  const days = Math.ceil((target - today) / 86400000);
  if (days === 0) return `${date} (오늘)`;
  return `${date} (${days > 0 ? `D-${days}` : `D+${Math.abs(days)}`})`;
}

export async function sendStatus() {
  const applied = appliedNotices();
  if (!applied.length) return sendMessage("현재 ‘지원함’으로 등록된 공고가 없습니다.");
  const lines = applied.map((notice, index) =>
    `${index + 1}. [${notice.source}] ${notice.title}\n   발표: ${dday(notice.effective_announcement_date)}`
  );
  return sendMessage(`📌 지원 진행 중\n\n${lines.join("\n\n")}`);
}

export async function sendDailyReport(summary = [], reviewSummary = []) {
  const notices = activeNotices();
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  const applied = appliedNotices();
  const seen = new Set();
  const candidates = notices.filter((notice) => {
    if (notice.application_status || !["likely", "possible"].includes(notice.verdict)) return false;
    if (notice.ai_eligibility === "no" || notice.ai_status === "closed") return false;
    if (notice.apply_end && notice.apply_end < today) return false;
    const key = notice.title.replace(/\s*\d+일전\s*$/, "").replace(/\s+/g, " ").trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 12);
  const counts = [...sourceOrder, "마이홈 API"].map((source) => {
    const item = summary.find((entry) => entry.source === source);
    return `${source} ${item?.error ? "오류" : item?.count ?? 0}`;
  }).join(" · ");

  const lines = [
    `🏠 서울 1인 청년 주거공고 · ${new Date().toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" })}`,
    `수집: ${counts}`,
    `후보 ${candidates.length}건 · 지원 진행 ${applied.length}건`,
    reviewSummary.length
      ? `AI 검토 ${reviewSummary.filter((item) => !item.error).length}건 · 오류 ${reviewSummary.filter((item) => item.error).length}건`
      : "변경 없음",
  ];

  if (applied.length) {
    lines.push("", "📌 지원 진행 중");
    for (const notice of applied.slice(0, 6)) {
      lines.push(`• [${notice.source}] ${notice.title.slice(0, 75)}`);
      lines.push(`  발표: ${dday(notice.effective_announcement_date)}`);
    }
  }

  lines.push("", candidates.length ? "🔎 오늘 확인할 공고" : "오늘 새로 확인할 공고가 없습니다.");
  candidates.forEach((notice, index) => {
    const reason = JSON.parse(notice.reasons_json || "[]")[0];
    const ai = notice.ai_result_json ? JSON.parse(notice.ai_result_json) : null;
    const label = ai
      ? `${notice.ai_eligibility === "yes" ? "🤖 추천" : "🤖 확인 필요"} ${notice.ai_score}점`
      : verdictLabel[notice.verdict] || "🔎";
    lines.push("", `${index + 1}. ${label} [${notice.source}]`);
    lines.push(notice.title.slice(0, 100));
    lines.push(`${notice.apply_end ? `마감 ${notice.apply_end}` : "마감일 확인 필요"} · ${ai?.summary || reason || "AI 검토 대기"}`);
    if (ai?.costs && ai.costs !== "확인 필요") lines.push(`비용: ${ai.costs.slice(0, 100)}`);
  });
  lines.push("", "※ AI는 공식 자료 근거만 사용하며, 개인 소득·자산 정보가 없으면 ‘확인 필요’로 표시합니다.");
  lines.push("답장 예: ‘3번 넣었어’, ‘3번 2026-08-10 발표’");

  const keyboard = candidates.map((notice, index) => [
    { text: `${index + 1} ✅`, callback_data: `h:ap:${notice.id}` },
    { text: `${index + 1} 🙈`, callback_data: `h:ig:${notice.id}` },
    { text: `${index + 1} 원문`, url: notice.url },
  ]);
  const message = await sendMessage(lines.join("\n").slice(0, 4090), {
    reply_markup: { inline_keyboard: keyboard },
  });
  saveDigestItems(message.message_id, candidates.map((notice) => notice.id));
}
