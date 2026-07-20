import { chromium } from "playwright";
import { officialSearchSource, searchOfficial } from "./official-tools.mjs";

const shListUrl = "https://www.i-sh.co.kr/app/lay2/program/S1T294C297/www/brd/m_247/list.do?multi_itm_seq=2";

function shDetailUrl(seq) {
  return `https://www.i-sh.co.kr/app/lay2/program/S1T294C297/www/brd/m_247/view.do?multi_itm_seq=2&seq=${seq}`;
}

export async function resolveHousingReminder(reminder) {
  const metadata = JSON.parse(reminder.metadata_json || "{}");
  if (metadata.source !== "SH") {
    const source = officialSearchSource(metadata.source, metadata.noticeTitle || "");
    const query = `${metadata.noticeTitle || reminder.title} 서류심사 대상자 발표`;
    const result = await searchOfficial(source, query);
    const found = result.match?.status === "matched"
      && /서류심사\s*대상자|당첨자\s*발표|선정\s*결과|대상자\s*발표/.test(`${result.matched || ""} ${result.text || ""}`);
    return {
      url: found ? result.url : reminder.url,
      note: found ? `${source} 공식 발표 게시물을 자동으로 찾았습니다.` : "공식 발표 게시물을 아직 찾지 못해 원 공고를 연결합니다.",
      found: Boolean(found),
      matchedTitle: found ? result.matched : null,
    };
  }

  const required = Array.isArray(metadata.keywords)
    ? metadata.keywords.filter((keyword) => typeof keyword === "string" && keyword.trim())
    : [];
  if (required.length < 2) {
    return {
      url: shListUrl,
      note: "공고를 안전하게 식별할 키워드가 부족해 자동 매칭하지 않았습니다.",
      found: false,
      matchedTitle: null,
    };
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ locale: "ko-KR", timezoneId: "Asia/Seoul" });
    await page.goto(shListUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(1800);
    const links = await page.locator("table a").evaluateAll((anchors) => anchors.map((anchor) => ({
      text: (anchor.textContent || "").replace(/\s+/g, " ").trim(),
      onclick: anchor.getAttribute("onclick") || "",
    })));
    const candidates = links
      .map((link) => {
        const seq = link.onclick.match(/getDetailView\(['"]?(\d+)/)?.[1];
        const keywordScore = required.filter((keyword) => link.text.includes(keyword)).length;
        const resultScore = /서류심사대상자|서류심사 대상자|당첨자\s*발표|대상자\s*발표/.test(link.text) ? 10 : 0;
        const penalty = /경쟁률/.test(link.text) ? 10 : 0;
        return { ...link, seq, score: keywordScore + resultScore - penalty };
      })
      .filter((link) => link.seq && required.every((keyword) => link.text.includes(keyword)))
      .sort((a, b) => b.score - a.score);

    const found = candidates[0];
    if (found && found.score >= required.length + 10) {
      return { url: shDetailUrl(found.seq), note: "SH 공식 발표 게시물을 자동으로 찾았습니다.", found: true, matchedTitle: found.text };
    }
    return { url: shListUrl, note: "발표 게시물을 아직 찾지 못해 SH 공식 공고 목록을 연결합니다.", found: false, matchedTitle: null };
  } finally {
    await browser.close();
  }
}
