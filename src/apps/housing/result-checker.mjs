import {
  dueApplicationResultChecks,
  markApplicationResultPrompted,
  saveApplicationResultCheck,
  saveTelegramMessage,
} from "../../db.mjs";
import { sendMessage } from "../../telegram.mjs";
import { officialSearchSource, searchOfficial } from "./official-tools.mjs";
import { resolveHousingReminder } from "./reminder-resolver.mjs";

const resultWords = /서류심사\s*대상자|당첨자\s*발표|선정\s*결과|대상자\s*발표/;

function kstDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(date);
}

export function housingResultKeywords(title) {
  const clean = String(title || "")
    .replace(/\(20\d{2}[.)/-].*?\)/g, " ")
    .replace(/입주자\s*모집(?:공고)?|모집공고|공고/g, " ")
    .replace(/\s+/g, " ").trim();
  const tokens = clean.split(" ").filter((token) => token.length >= 2);
  const yearRound = clean.match(/20\d{2}년\s*\d+차/)?.[0];
  const distinctive = tokens.filter((token) => /청년|신혼|매입임대|전세임대|행복주택|국민임대/.test(token));
  return [...new Set([yearRound, ...distinctive].filter(Boolean))].slice(0, 4);
}

export async function discoverOfficialHousingResult(notice) {
  const source = officialSearchSource(notice.source, notice.raw_text);
  if (source === "SH") {
    return resolveHousingReminder({
      url: notice.url,
      metadata_json: JSON.stringify({ source: "SH", keywords: housingResultKeywords(notice.title) }),
    });
  }
  const query = `${String(notice.title || "").replace(/\s*\(20\d{2}.*?\)\s*$/, "")} 서류심사 대상자 발표`;
  const result = await searchOfficial(source, query);
  const found = Boolean(result.match?.status === "matched" && resultWords.test(`${result.matched || ""} ${result.text || ""}`));
  return {
    found,
    url: found ? result.url : null,
    matchedTitle: found ? result.matched : null,
    note: found ? `${source} 공식 발표 게시물을 자동으로 찾았습니다.` : "공식 발표 게시물을 아직 찾지 못했습니다.",
  };
}

export async function runHousingResultChecks({
  now = new Date(),
  staleMs = 6 * 60 * 60_000,
  limit = 5,
  discover = discoverOfficialHousingResult,
  send = sendMessage,
} = {}) {
  const due = dueApplicationResultChecks(kstDate(now), new Date(now.getTime() - staleMs).toISOString(), limit);
  const results = [];
  for (const notice of due) {
    try {
      const discovered = await discover(notice);
      const check = saveApplicationResultCheck(notice.id, {
        state: discovered.found ? "found" : "not_found",
        officialUrl: discovered.found ? discovered.url : null,
        matchedTitle: discovered.matchedTitle || null,
        checkedAt: now.toISOString(),
      });
      if (discovered.found && !check.prompted_at) {
        const message = await send(
          `🏁 지원 결과 발표 확인\n\n[${notice.source}] ${notice.title}\n${discovered.matchedTitle ? `발표: ${discovered.matchedTitle}\n` : ""}공식 확인: ${discovered.url}\n\n이번 서류심사 결과를 선택해 주세요.`,
          {
            reply_markup: {
              inline_keyboard: [[
                { text: "✅ 서류심사 선정", callback_data: `h:rs:${notice.id}` },
                { text: "❌ 미선정", callback_data: `h:rn:${notice.id}` },
              ]],
            },
          },
        );
        saveTelegramMessage(message.message_id, notice.id);
        markApplicationResultPrompted(notice.id);
      }
      results.push({ id: notice.id, found: Boolean(discovered.found), prompted: Boolean(discovered.found && !check.prompted_at) });
    } catch (error) {
      saveApplicationResultCheck(notice.id, { state: "error", error: error.message, checkedAt: now.toISOString() });
      results.push({ id: notice.id, error: error.message });
    }
  }
  return results;
}
