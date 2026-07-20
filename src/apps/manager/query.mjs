import { runReadOnlyDiagnosticAgent } from "./agent.mjs";

const managerTerms = /(?:life\s*daemon|라이프\s*데몬|시스템|상태|정상|장애|오류|실패|왜|원인|문제|로그|진단|수집|크롤|언제\s*(?:돌|실행)|다음\s*실행|우선\s*순위|추천\s*기준|채용\s*조건|주택\s*조건|타이머|서비스|봇|캘린더|리마인더|알림|지원\s*현황)/i;

export function looksLikeManagerQuestion(text) {
  const value = String(text || "").trim();
  return /^\/(?:daemon|system|ask)(?:@\w+)?(?:\s|$)/i.test(value)
    || /^\/job(?:@\w+)?\s+/i.test(value)
    || managerTerms.test(value);
}

function kst(value) {
  if (!value) return "기록 없음";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return `${new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Seoul",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(date)} KST`;
}

function list(value) {
  return Array.isArray(value) && value.length ? value.join(" → ") : "설정 없음";
}

function jobPriorityAnswer(snapshot) {
  if (!snapshot.jobs?.available) return `채용 설정을 읽지 못했습니다: ${snapshot.jobs?.error || "원인 미상"}`;
  const profile = snapshot.jobs.profile || {};
  const preferences = profile.preferences || {};
  const filters = profile.companyFilters || {};
  const recommended = snapshot.jobs.recommended || [];
  return [
    "💼 현재 채용 우선순위",
    `선호 직무: ${list(preferences.preferredRoles)}`,
    `탐색어: ${list(preferences.discoveryQueries || preferences.preferredRoles)}`,
    `제외 직무: ${list(preferences.excludedRoles)}`,
    `회사 필터: 잡플래닛 ${filters.jobplanet?.minimumRating ?? "?"}점 이상 · 직원 ${filters.minimumEmployeeCount ?? "?"}명 이상 · 미검증 회사 ${filters.jobplanet?.excludeWhenMissing === true ? "제외" : "별도 확인"}`,
    recommended.length
      ? `현재 추천 상위: ${recommended.slice(0, 5).map((job, index) => `${index + 1}. ${job.company} — ${job.title} (${job.decision})`).join(" / ")}`
      : "현재 조건을 통과한 추천 공고는 없습니다.",
  ].join("\n");
}

function timerFor(snapshot, unit) {
  return snapshot.services?.find((service) => service.unit === unit);
}

function collectionAnswer(snapshot) {
  const housing = snapshot.housing?.collection || {};
  const jobs = snapshot.jobs?.collection || {};
  const housingTimer = timerFor(snapshot, "housing-daily.timer");
  const jobTimer = timerFor(snapshot, "jobs-daily.timer");
  return [
    "🕒 수집 실행 현황",
    `주택: 마지막 시도 ${kst(housing.lastAttemptAt)} · 마지막 성공 ${kst(housing.lastSuccessAt)} · 다음 실행 ${kst(housingTimer?.NextElapseUSecRealtime)}`,
    `채용: 마지막 시도 ${kst(jobs.lastAttemptAt)} · 마지막 성공 ${kst(jobs.lastSuccessAt)} · 다음 실행 ${kst(jobTimer?.NextElapseUSecRealtime)}`,
  ].join("\n");
}

function systemAnswer(snapshot) {
  const units = (snapshot.services || []).map((service) => {
    if (!service.available) return `⚠️ ${service.unit}: 조회 실패`;
    const healthy = service.ActiveState === "active" || (service.ActiveState === "inactive" && service.Result === "success");
    return `${healthy ? "✅" : "⚠️"} ${service.unit}: ${service.ActiveState || "unknown"}/${service.SubState || "unknown"}${service.Result ? ` · ${service.Result}` : ""}`;
  });
  return [`🧭 Life Daemon v${snapshot.version}`, ...units, "", collectionAnswer(snapshot)].join("\n");
}

export function directManagerAnswer(question, snapshot) {
  const value = String(question || "");
  if (/(?:채용|job).*(?:우선\s*순위|조건|기준)|(?:우선\s*순위|조건|기준).*(?:채용|job)/i.test(value)) {
    return jobPriorityAnswer(snapshot);
  }
  if (/(?:수집|크롤).*(?:언제|최근|마지막|다음|실행)|(?:언제|최근|마지막|다음).*(?:수집|크롤)/i.test(value)) {
    return collectionAnswer(snapshot);
  }
  if (/^\/(?:daemon|system)(?:@\w+)?\s*$/i.test(value) || /(?:전체|시스템|daemon).*(?:상태|정상|현황)|(?:상태|정상|현황).*(?:전체|시스템|daemon)/i.test(value)) {
    return systemAnswer(snapshot);
  }
  return null;
}

export async function answerManagerQuestion(question, snapshot, {
  agent = runReadOnlyDiagnosticAgent,
  ...agentOptions
} = {}) {
  const direct = /왜|원인|실패|오류|장애|로그|진단|문제/i.test(String(question || ""))
    ? null
    : directManagerAnswer(question, snapshot);
  if (direct) return direct;
  try {
    return await agent({ question, snapshot, ...agentOptions });
  } catch (error) {
    console.error("Manager AI answer failed", error.message);
    return `${systemAnswer(snapshot)}\n\n질문의 세부 해석에는 실패했습니다. /ask 뒤에 채용·주택·수집·서비스 중 대상을 포함해 다시 물어봐 주세요.`;
  }
}
