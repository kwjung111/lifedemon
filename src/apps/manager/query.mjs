import { runReadOnlyDiagnosticAgent } from "./agent.mjs";

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

export async function answerManagerQuestion(question, snapshot, {
  agent = runReadOnlyDiagnosticAgent,
  ...agentOptions
} = {}) {
  try {
    return await agent({ question, snapshot, ...agentOptions });
  } catch (error) {
    console.error("Manager AI answer failed", error.message);
    return `${systemAnswer(snapshot)}\n\n질문의 세부 해석에는 실패했습니다. /ask 뒤에 채용·주택·수집·서비스 중 대상을 포함해 다시 물어봐 주세요.`;
  }
}
