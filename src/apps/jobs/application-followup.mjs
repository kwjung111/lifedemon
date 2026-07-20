import { proposeReminder } from "../reminders/service.mjs";

const eventPattern = /면접|서류\s*(?:심사\s*)?(?:결과|발표)|합격자\s*발표|전형\s*결과/;

function parseDateTime(text) {
  const normalized = String(text || "")
    .replace(/(20\d{2})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일/g, "$1-$2-$3")
    .replace(/\s+/g, " ");
  const event = eventPattern.exec(normalized);
  if (!event) return null;
  const window = normalized.slice(event.index, event.index + 240);
  const date = window.match(/(20\d{2})[.\/-](\d{1,2})[.\/-](\d{1,2})/);
  if (!date) return null;
  const koreanTime = window.match(/(오전|오후)\s*(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분)?/);
  const colonTime = window.match(/(?:^|[^\d])([01]?\d|2[0-3]):([0-5]\d)(?:[^\d]|$)/);
  if (!koreanTime && !colonTime) return null;
  let hour;
  let minute;
  if (koreanTime) {
    hour = Number(koreanTime[2]);
    if (koreanTime[1] === "오후" && hour < 12) hour += 12;
    if (koreanTime[1] === "오전" && hour === 12) hour = 0;
    minute = Number(koreanTime[3] || 0);
  } else {
    hour = Number(colonTime[1]);
    minute = Number(colonTime[2]);
  }
  return {
    label: event[0].replace(/\s+/g, " "),
    dueAt: new Date(`${date[1]}-${date[2].padStart(2, "0")}-${date[3].padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+09:00`),
  };
}

export function jobApplicationFollowup(job, { now = new Date() } = {}) {
  const parsed = parseDateTime(`${job.title || ""}\n${job.raw_text || job.rawText || ""}`);
  if (!parsed || Number.isNaN(parsed.dueAt.getTime()) || parsed.dueAt.getTime() <= now.getTime()) return null;
  return {
    title: `${job.company} · ${job.title} · ${parsed.label}`.slice(0, 180),
    dueAt: parsed.dueAt.toISOString(),
    url: job.url || null,
    module: "jobs",
    entityKey: `${job.id}:application-followup:${parsed.dueAt.toISOString()}`,
    metadata: { domain: "jobs", entityId: job.id, company: job.company, title: job.title },
  };
}

export async function proposeJobApplicationFollowup(job, options = {}) {
  const reminder = jobApplicationFollowup(job, options);
  if (!reminder) return null;
  await proposeReminder(reminder, { intro: options.intro || null });
  return reminder;
}
