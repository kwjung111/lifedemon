import { proposeReminder } from "../reminders/service.mjs";

const eventPattern = /서류심사\s*대상자\s*발표|당첨자\s*발표|선정\s*결과|결과\s*발표|발표일/;

function isoDate(value) {
  const match = String(value || "").match(/(20\d{2})[.\/-]\s*(\d{1,2})[.\/-]\s*(\d{1,2})/);
  return match ? `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}` : null;
}

function announcedDate(text) {
  const normalized = String(text || "").replace(/(20\d{2})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일/g, "$1.$2.$3");
  const match = normalized.match(new RegExp(`${eventPattern.source}[^\\d]{0,40}(20\\d{2}[.\\/-]\\s*\\d{1,2}[.\\/-]\\s*\\d{1,2})`));
  return isoDate(match?.[1]);
}

function announcementWindow(text) {
  const normalized = String(text || "").replace(/\s+/g, " ");
  const match = eventPattern.exec(normalized);
  if (!match) return normalized.slice(0, 400);
  return normalized.slice(match.index, match.index + 260);
}

function announcedTime(text) {
  const window = announcementWindow(text);
  const korean = window.match(/(오전|오후)\s*(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분)?/);
  if (korean) {
    let hour = Number(korean[2]);
    if (korean[1] === "오후" && hour < 12) hour += 12;
    if (korean[1] === "오전" && hour === 12) hour = 0;
    return `${String(hour).padStart(2, "0")}:${String(Number(korean[3] || 0)).padStart(2, "0")}`;
  }
  const colon = window.match(/(?:^|[^\d])([01]?\d|2[0-3]):([0-5]\d)(?:[^\d]|$)/);
  return colon ? `${colon[1].padStart(2, "0")}:${colon[2]}` : null;
}

function resultLabel(text) {
  const match = String(text || "").match(eventPattern);
  if (!match) return "지원 결과 발표";
  if (/서류심사/.test(match[0])) return "서류심사대상자 발표";
  if (/당첨자/.test(match[0])) return "당첨자 발표";
  return "지원 결과 발표";
}

function keywords(title) {
  const clean = String(title || "")
    .replace(/\(20\d{2}[.)/-].*?\)/g, " ")
    .replace(/입주자\s*모집(?:공고)?|모집공고|공고/g, " ")
    .replace(/\s+/g, " ").trim();
  const yearRound = clean.match(/20\d{2}년\s*\d+차/)?.[0];
  const distinctive = clean.split(" ").filter((token) => /청년|신혼|매입임대|전세임대|행복주택|국민임대/.test(token));
  return [...new Set([yearRound, ...distinctive].filter(Boolean))].slice(0, 4);
}

export function housingApplicationFollowup(notice, { announcementDate = null, now = new Date() } = {}) {
  const raw = `${notice.title || ""}\n${notice.raw_text || notice.rawText || ""}`;
  const date = isoDate(announcementDate || notice.effective_announcement_date || notice.announcement_date)
    || announcedDate(raw);
  if (!date) return null;
  const detectedTime = announcedTime(raw);
  const time = detectedTime || "09:00";
  const dueAt = new Date(`${date}T${time}:00+09:00`);
  if (Number.isNaN(dueAt.getTime()) || dueAt.getTime() <= now.getTime()) return null;
  const label = resultLabel(raw);
  return {
    title: `${String(notice.title || "주택 공고").slice(0, 100)} · ${label}`,
    dueAt: dueAt.toISOString(),
    url: notice.url || null,
    module: "housing",
    entityKey: `${notice.id}:document-result`,
    resolver: "housing-official",
    metadata: {
      source: notice.source,
      eventType: "document-screening-result",
      noticeId: notice.id,
      noticeTitle: notice.title,
      keywords: keywords(notice.title),
      assumedTime: !detectedTime,
    },
  };
}

export async function proposeHousingApplicationFollowup(notice, options = {}) {
  const reminder = housingApplicationFollowup(notice, options);
  if (!reminder) return null;
  await proposeReminder(reminder, { intro: options.intro || null });
  return reminder;
}
