import { activeNotices, appliedNotices, exhaustedReviewCount, getSetting, saveDigestItems } from "./db.mjs";
import { scoreLabel } from "./apps/housing/scoring.mjs";
import { sendMessage } from "./telegram.mjs";

const verdictLabel = { likely: "✅ 적합 가능성 높음", possible: "🟡 가능성 있음", review: "🔎 추가 확인" };
const sourceOrder = ["마이홈 API", "청년안심주택", "HUG"];

function healthTime(value) {
  if (!value) return "아직 없음";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "확인 필요";
  return date.toLocaleString("ko-KR", { timeZone: "Asia/Seoul", hour12: false });
}

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
  const allCandidates = notices.filter((notice) => {
    if (notice.application_status || !["likely", "possible"].includes(notice.verdict)) return false;
    if (notice.ai_eligibility === "no" || notice.ai_status === "closed") return false;
    if (notice.apply_end && notice.apply_end < today) return false;
    const key = notice.title.replace(/\s*\d+일전\s*$/, "").replace(/\s+/g, " ").trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const candidates = allCandidates;
  const exhaustedReviews = exhaustedReviewCount();
  const deferredReviews = reviewSummary.filter((item) => item.deferred).reduce((sum, item) => sum + (item.count || 0), 0);
  const completedReviews = reviewSummary.filter((item) => !item.error && !item.deferred).length;
  const failedReviews = reviewSummary.filter((item) => item.error && !item.deferred).length;
  const counts = sourceOrder.map((source) => {
    const item = summary.find((entry) => entry.source === source);
    return `${source} ${item?.error ? "오류" : item?.count ?? 0}`;
  }).join(" · ");
  const newCount = summary.reduce((total, item) => total + (item.newCount || 0), 0);
  const changedCount = summary.reduce((total, item) => total + (item.changedCount || 0), 0);
  const deactivatedCount = summary.reduce((total, item) => total + (item.deactivatedCount || 0), 0);
  const collectionErrors = summary.filter((item) => item.error || item.skipped).length;

  const lines = [
    `🏠 서울 1인 청년 주거공고 · ${new Date().toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" })}`,
    `수집: ${counts}`,
    `품질: 신규 ${newCount} · 변경 ${changedCount} · 종료 ${deactivatedCount} · 오류 ${collectionErrors}`,
    `마지막 정상 수집: ${healthTime(getSetting("housing_collection_last_success_at"))}`,
    `후보 ${allCandidates.length}건 · 지원 진행 ${applied.length}건`,
    reviewSummary.length
      ? `AI 검토 ${completedReviews}건 · 오류 ${failedReviews}건${deferredReviews ? ` · 다음 실행 ${deferredReviews}건` : ""}`
      : "변경 없음",
  ];

  if (allCandidates.length > candidates.length) {
    lines.push(`표시 제한: 상위 ${candidates.length}건 · 미표시 ${allCandidates.length - candidates.length}건`);
  }
  if (exhaustedReviews) {
    lines.push(`⚠️ AI 검토 재시도 소진 ${exhaustedReviews}건 · 운영 확인 필요`);
  }

  if (applied.length) {
    lines.push("", "📌 지원 진행 중");
    for (const notice of applied.slice(0, 6)) {
      lines.push(`• [${notice.source}] ${notice.title.slice(0, 75)}`);
      lines.push(`  발표: ${dday(notice.effective_announcement_date)}`);
    }
  }

  lines.push("", candidates.length ? "🔎 오늘 확인할 공고" : "오늘 새로 확인할 공고가 없습니다.");
  const pages = [{ lines, notices: [] }];
  let currentPage = pages[0];
  for (const notice of candidates) {
    const index = currentPage.notices.length;
    const reason = JSON.parse(notice.reasons_json || "[]")[0];
    const ai = notice.ai_result_json ? JSON.parse(notice.ai_result_json) : null;
    const label = ai ? `🤖 ${scoreLabel(ai)}` : verdictLabel[notice.verdict] || "🔎";
    const block = [
      "",
      `${index + 1}. ${label} [${notice.source}]`,
      notice.title.slice(0, 100),
      `${notice.apply_end ? `마감 ${notice.apply_end}` : "마감일 확인 필요"} · ${ai?.summary || reason || "AI 검토 대기"}`,
    ];
    if (ai?.critical_unknowns?.length) {
      block.push(`확인할 것: ${ai.critical_unknowns.slice(0, 2).join(" · ").slice(0, 140)}`);
    }
    if (ai?.evidence_gaps?.length) {
      block.push(`공식자료 부족: ${ai.evidence_gaps.slice(0, 2).join(" · ").slice(0, 140)}`);
    }
    if (ai?.costs && ai.costs !== "확인 필요") block.push(`비용: ${ai.costs.slice(0, 100)}`);
    if ([...currentPage.lines, ...block].join("\n").length > 3_800 && currentPage.notices.length) {
      currentPage = {
        lines: [
          `🏠 서울 1인 청년 주거공고 · ${new Date().toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" })}`,
          `🔎 오늘 확인할 공고 (계속 ${pages.length + 1})`,
        ],
        notices: [],
      };
      pages.push(currentPage);
      block[1] = `1. ${label} [${notice.source}]`;
    }
    currentPage.lines.push(...block);
    currentPage.notices.push(notice);
  }
  for (const page of pages) {
    page.lines.push("", "※ 자격·공식 근거가 불확실한 점수는 ‘(추정)’으로 표시합니다.");
    page.lines.push("답장 예: ‘3번 넣었어’, ‘3번 2026-08-10 발표’");
    const keyboard = page.notices.map((notice, index) => [
      { text: `${index + 1} ✅`, callback_data: `h:ap:${notice.id}` },
      { text: `${index + 1} 🙈`, callback_data: `h:ig:${notice.id}` },
      { text: `${index + 1} 원문`, url: notice.url },
    ]);
    const message = await sendMessage(page.lines.join("\n").slice(0, 4090), {
      reply_markup: { inline_keyboard: keyboard },
    });
    saveDigestItems(message.message_id, page.notices.map((notice) => notice.id));
  }
}
