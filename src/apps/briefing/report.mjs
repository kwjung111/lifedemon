import { getJobSetting } from "../jobs/db.mjs";
import { jobReportSnapshot } from "../jobs/report.mjs";
import { getSetting } from "../../db.mjs";
import { housingReportSnapshot } from "../../report.mjs";
import {
  getPlatformSetting,
  listReminders,
  setPlatformSetting,
} from "../../core/state.mjs";
import { sendMessage } from "../../telegram.mjs";
import { listInboxActionItems } from "../inbox/store.mjs";

const escapeHtml = (value) => String(value || "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const link = (url, label) => `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;

function kstDate(value = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(value);
}

function kstDateTime(value) {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul", month: "numeric", day: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(value));
}

function parseSummary(value) {
  try {
    const parsed = JSON.parse(value || "null");
    return parsed && Array.isArray(parsed.summary) ? parsed : { completedAt: null, summary: [] };
  } catch { return { completedAt: null, summary: [] }; }
}

function changeCounts(entries) {
  return entries.reduce((result, item) => ({
    newCount: result.newCount + (Number(item.newCount) || 0),
    changedCount: result.changedCount + (Number(item.changedCount) || 0),
    errors: result.errors + Number(Boolean(item.error || item.skipped)),
  }), { newCount: 0, changedCount: 0, errors: 0 });
}

function signature(items) {
  return items.map((item) => `${item.id}:${item.content_hash || ""}`).join("|");
}

function todayActions({ reminders, appliedHousing, now = new Date() }) {
  const today = kstDate(now);
  const seen = new Set();
  const actions = [];
  for (const reminder of reminders) {
    if (reminder.status !== "approved" || kstDate(new Date(reminder.due_at)) !== today) continue;
    const key = String(reminder.title).replace(/\s+/g, "").slice(0, 80);
    seen.add(key);
    actions.push({ title: reminder.title, at: reminder.due_at, url: reminder.url || null });
  }
  for (const notice of appliedHousing) {
    if (notice.effective_announcement_date !== today) continue;
    const key = String(notice.title).replace(/\s+/g, "").slice(0, 80);
    if ([...seen].some((value) => value.includes(key) || key.includes(value))) continue;
    actions.push({ title: `${notice.title} 발표 확인`, at: null, url: notice.url });
  }
  return actions.sort((left, right) => String(left.at || "").localeCompare(String(right.at || "")));
}

export function morningBriefingSnapshot({ now = new Date(), housingLimit = 3, jobLimit = 3 } = {}) {
  const housing = housingReportSnapshot({ limit: housingLimit });
  const jobs = jobReportSnapshot({ limit: jobLimit });
  const housingCollection = parseSummary(getSetting("housing_collection_last_summary"));
  const jobCollection = parseSummary(getJobSetting("job_collection_last_summary"));
  const housingChanges = changeCounts(housingCollection.summary);
  const jobChanges = changeCounts(jobCollection.summary);
  const housingSignature = signature(housing.candidates);
  const jobSignature = signature(jobs.selected);
  const previousHousingSignature = getPlatformSetting("morning_briefing_housing_signature", null);
  const previousJobSignature = getPlatformSetting("morning_briefing_jobs_signature", null);
  const housingChanged = previousHousingSignature === null || previousHousingSignature !== housingSignature;
  const jobsChanged = previousJobSignature === null || previousJobSignature !== jobSignature;
  const reminders = listReminders();
  const inbox = listInboxActionItems({ now, limit: 8 }).filter((item) => !reminders.some((reminder) => (
    reminder.status === "approved"
      && reminder.due_at === item.event_at
      && String(reminder.title).replace(/\s+/g, "") === String(item.title).replace(/\s+/g, "")
  ))).slice(0, 3);
  return {
    date: kstDate(now),
    actions: todayActions({ reminders, appliedHousing: housing.applied, now }),
    inbox,
    housing: { ...housing, ...housingChanges, changed: housingChanged, signature: housingSignature },
    jobs: { ...jobs, ...jobChanges, changed: jobsChanged, signature: jobSignature },
    collectionAt: { housing: housingCollection.completedAt, jobs: jobCollection.completedAt },
  };
}

export function formatMorningBriefing(snapshot) {
  const lines = [`☀️ ${snapshot.date} 오늘의 브리핑`];
  const items = [];
  if (snapshot.actions.length) {
    lines.push("", `🚨 오늘 할 일 ${snapshot.actions.length}개`);
    for (const action of snapshot.actions.slice(0, 12)) {
      const title = action.url ? link(action.url, String(action.title).slice(0, 90)) : escapeHtml(String(action.title).slice(0, 90));
      lines.push(`• ${action.at ? kstDateTime(action.at) : "오늘"} · ${title}`);
    }
    if (snapshot.actions.length > 12) lines.push(`• 외 ${snapshot.actions.length - 12}개 · /reminders에서 확인`);
  } else lines.push("", "🚨 오늘 울릴 정시 알림 없음");

  if (snapshot.inbox?.length) {
    lines.push("", `📥 다음 행동 ${snapshot.inbox.length}개`);
    for (const item of snapshot.inbox) {
      const index = items.length + 1;
      items.push({ index, id: item.id, domain: "inbox", title: item.title });
      const at = item.event_at ? ` · ${kstDateTime(item.event_at)}` : "";
      const title = item.source_url ? link(item.source_url, item.title) : escapeHtml(item.title);
      lines.push(`${index}. ${escapeHtml(item.next_action)} — ${title}${at}`);
    }
  }

  const housingShow = snapshot.housing.changed;
  lines.push("", `🏠 주택 · 추천 후보 ${snapshot.housing.allCandidates.length}건 · 지원 진행 ${snapshot.housing.applied.length}건`);
  lines.push(`신규 ${snapshot.housing.newCount} · 변경 ${snapshot.housing.changedCount} · 수집 오류 ${snapshot.housing.errors}`);
  if (!housingShow) lines.push(snapshot.housing.newCount || snapshot.housing.changedCount
    ? "상위 추천 변화 없음 · 나머지 신규·변경 공고는 저장됨"
    : "변경 없음");
  else if (!snapshot.housing.candidates.length) lines.push("새로 확인할 추천 공고 없음");
  else {
    for (const notice of snapshot.housing.candidates) {
      const index = items.length + 1;
      items.push({ index, id: notice.id, domain: "housing", title: notice.title, source: notice.source });
      lines.push(`${index}. ${link(notice.url, `[${notice.source}] ${String(notice.title).slice(0, 82)}`)}${notice.apply_end ? ` · 마감 ${notice.apply_end}` : ""}`);
    }
  }

  const jobsShow = snapshot.jobs.changed;
  lines.push("", `💼 채용 · 적합 ${snapshot.jobs.summary.counts.pass || 0} · 확인 ${snapshot.jobs.summary.counts.uncertain || 0} · 지원 진행 ${snapshot.jobs.applications.length}건`);
  lines.push(`신규 ${snapshot.jobs.newCount} · 변경 ${snapshot.jobs.changedCount} · 수집 오류 ${snapshot.jobs.errors}`);
  if (!jobsShow) lines.push(snapshot.jobs.newCount || snapshot.jobs.changedCount
    ? "상위 추천 변화 없음 · 나머지 신규·변경 공고는 저장됨"
    : "변경 없음");
  else if (!snapshot.jobs.selected.length) lines.push("새로 확인할 추천 공고 없음");
  else {
    for (const job of snapshot.jobs.selected) {
      const index = items.length + 1;
      items.push({ index, id: job.id, domain: "jobs", title: job.title, company: job.company, source: job.source });
      lines.push(`${index}. ${link(job.url, `${String(job.company).slice(0, 35)} — ${String(job.title).slice(0, 70)}`)}`);
    }
  }
  lines.push("", "더 보기: ‘주택 더 보여줘’ 또는 ‘채용 더 보여줘’");
  if (items.length) lines.push("답장 예: ‘3번 신청했어’, ‘5번 회사는 좋은데 직무는 별로’");
  return { text: lines.join("\n").slice(0, 4000), items };
}

export async function sendMorningBriefing({ now = new Date(), deliveryKey = null } = {}) {
  const snapshot = morningBriefingSnapshot({ now });
  const formatted = formatMorningBriefing(snapshot);
  const applicationItems = formatted.items.filter((item) => ["housing", "jobs"].includes(item.domain));
  const shownByDomain = {
    housing: formatted.items.filter((item) => item.domain === "housing").length,
    jobs: formatted.items.filter((item) => item.domain === "jobs").length,
  };
  const message = await sendMessage(formatted.text, {
    parse_mode: "HTML",
    ...(applicationItems.length ? {
      reply_markup: {
        inline_keyboard: applicationItems.map((item) => [{
          text: `${item.index}번 ${item.domain === "housing" ? "신청했어" : "지원했어"}`,
          callback_data: `${item.domain === "housing" ? "h" : "j"}:ap:${item.id}`,
        }]),
      },
    } : {}),
  }, {
    dedupeKey: deliveryKey,
    context: { domain: "briefing", kind: "digest", items: formatted.items, shownByDomain },
  });
  setPlatformSetting("morning_briefing_housing_signature", snapshot.housing.signature);
  setPlatformSetting("morning_briefing_jobs_signature", snapshot.jobs.signature);
  setPlatformSetting("morning_briefing_last_sent_at", new Date().toISOString());
  return message;
}

export async function sendMoreRecommendations(domain, { offset = 0, limit = 6 } = {}) {
  const snapshot = domain === "housing"
    ? housingReportSnapshot({ offset, limit })
    : jobReportSnapshot({ offset, limit });
  const rows = (domain === "housing" ? snapshot.candidates : snapshot.selected)
    .map((row) => ({ ...row, domain }));
  if (!rows.length) return sendMessage(`${domain === "housing" ? "주택" : "채용"} 추천에서 더 보여드릴 공고가 없습니다.`);
  const start = Math.max(0, Number(offset) || 0);
  const total = start + rows.length + snapshot.remaining;
  const items = rows.map((row, index) => ({
    index: index + 1, id: row.id, domain,
    title: row.title, company: row.company || null, source: row.source,
  }));
  const lines = [`${domain === "housing" ? "🏠 주택" : "💼 채용"} 추천 · ${start + 1}–${start + rows.length} / ${total}`];
  for (const [index, row] of rows.entries()) {
    const label = domain === "housing" ? `[${row.source}] ${row.title}` : `${row.company} — ${row.title}`;
    lines.push(`${index + 1}. ${link(row.url, String(label).slice(0, 115))}`);
  }
  lines.push("", "이 메시지에 번호와 함께 평소 말투로 답장해 주세요.");
  if (snapshot.remaining > 0) lines.push("다음 목록은 이 메시지에 ‘더 보여줘’라고 답장하세요.");
  return sendMessage(lines.join("\n"), {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: items.map((item) => [{
        text: `${item.index}번 ${domain === "housing" ? "신청했어" : "지원했어"}`,
        callback_data: `${domain === "housing" ? "h" : "j"}:ap:${item.id}`,
      }]),
    },
  }, {
    context: {
      domain, kind: "digest", items, offset: start,
      nextOffset: start + rows.length, remaining: snapshot.remaining,
    },
  });
}
