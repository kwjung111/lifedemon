import { chromium } from "playwright";
import { listHousingRules, markSourceCollectionComplete, markSourceCollectionEmpty, setSetting, upsertNoticeWithStatus } from "./db.mjs";
import { classify, extractDates } from "./classify.mjs";
import { collectMyHomeApi } from "./myhome-api.mjs";

const sources = [
  { name: "청년안심주택", url: "https://soco.seoul.go.kr/youth/bbs/BMSR00015/list.do?menuNo=400008" },
  { name: "HUG", url: "https://www.khug.or.kr/jeonse/web/s07/s070102.jsp" },
];

const clean = (value) => (value || "").replace(/\s+/g, " ").trim();
const noticeWords = /모집|입주자|예비입주자|청년주택|임대주택|든든전세|잔여세대/;
const closedWords = /당첨자|경쟁률|서류심사|발표|마감|공급완료/;
const youthSupplyStatus = new Set(["01", "02", "03", "04", "05", "06", "07"]);

function youthKeywords(value) {
  return clean(value)
    .replace(/\[[^\]]+\]|최초모집공고|추가모집공고|모집공고/g, "")
    .split(/\s+/)
    .filter((word) => word.length >= 2 && !/^(서울|청년|주택|아파트|민간임대)$|역$|모집/.test(word));
}

export function classifyYouthSupplyResponse(payload, candidates = []) {
  const rows = payload?.resultList;
  const paging = payload?.pagingInfo;
  const total = Number(paging?.totRow);
  const totalPages = Number(paging?.totPage);
  if (!Array.isArray(rows) || !Number.isInteger(total) || total < 0 || !Number.isInteger(totalPages) || totalPages < 1) {
    return { state: "error", notices: [], message: "청년안심주택 공급현황 응답 구조를 확인할 수 없음" };
  }
  if (rows.length !== total || totalPages !== 1) {
    return { state: "error", notices: [], message: `청년안심주택 공급현황 불완전 응답 ${rows.length}/${total}건` };
  }
  if (rows.some((row) => !row?.homeCode || !row?.homeName || !youthSupplyStatus.has(String(row.supplyStatus)))) {
    return { state: "error", notices: [], message: "청년안심주택 공급현황에 알 수 없는 상태 또는 필수 필드가 있음" };
  }
  const active = rows.filter((row) => ["01", "02"].includes(String(row.supplyStatus)));
  if (!active.length) return { state: "empty", notices: [], message: "공식 공급현황상 청약예정·청약중 공고 없음" };
  const matchedCandidates = new Set();
  const unmatched = active.filter((row) => {
    const homeName = clean(row.homeName);
    const homeWords = youthKeywords(homeName);
    const matches = candidates.filter((candidate) => {
    const candidateWords = youthKeywords(candidate.title);
      const overlap = homeWords.filter((word) => candidateWords.some((candidateWord) => candidateWord === word));
      return candidate.title.includes(homeName) || homeName.includes(candidate.title) || overlap.length >= 2;
    });
    for (const candidate of matches) matchedCandidates.add(candidate);
    return matches.length === 0;
  });
  if (unmatched.length) return { state: "error", notices: [], message: `활성 단지 ${active.length}건 중 ${unmatched.length}건을 모집공고 목록과 연결하지 못함` };
  return { state: "ok", notices: [...matchedCandidates] };
}

export function classifyHugCollection({ bodyText, totalText, dataRowCount, notices = [] }) {
  const totalMatch = clean(totalText).match(/총\s*([\d,]+)건/);
  if (!totalMatch) return { state: "error", notices: [], message: "HUG 총 공고 건수 구조를 확인할 수 없음" };
  const total = Number(totalMatch[1].replace(/,/g, ""));
  const emptyMarker = /등록된 게시물이 없습니다/.test(clean(bodyText));
  if (total === 0 && Number(dataRowCount) === 0 && emptyMarker) {
    return { state: "empty", notices: [], message: "공식 목록상 공고 없음" };
  }
  if (total === 0 || emptyMarker || Number(dataRowCount) !== total || !notices.length) {
    return { state: "error", notices: [], message: `HUG 목록 신호 불일치: 총 ${total}건, 표 ${dataRowCount}건, 파싱 ${notices.length}건` };
  }
  return { state: "ok", notices };
}

async function anchorCandidates(page, source) {
  const links = await page.locator("a").evaluateAll((anchors) => anchors.map((a) => ({
    text: (a.textContent || "").replace(/\s+/g, " ").trim(),
    href: a.href,
  })));
  return links
    .filter((link) => link.text.length >= 8 && noticeWords.test(link.text))
    .map((link) => ({ title: link.text, url: link.href || source.url, rawText: link.text }));
}

async function collectSource(context, source, rules) {
  const page = await context.newPage();
  try {
    const response = await page.goto(source.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    if (!response || response.status() >= 400) throw new Error(`HTTP ${response?.status()}`);
    await page.waitForTimeout(2500);
    const anchors = await anchorCandidates(page, source);
    let items = [];
    let collectionState = { state: "ok", notices: items };

    if (source.name === "청년안심주택") {
      const candidates = anchors.filter((item) => item.url.includes("BMSR00015/view.do"));
      const statusResponse = await context.request.post(
        "https://soco.seoul.go.kr/youth/pgm/home/yohome/mainYoHomeListJson.json",
        { form: { pageIndex: "1", rowCount: "500" }, timeout: 45_000 },
      );
      if (!statusResponse.ok()) throw new Error(`청년안심주택 공급현황 HTTP ${statusResponse.status()}`);
      collectionState = classifyYouthSupplyResponse(await statusResponse.json(), candidates);
      items = collectionState.notices;
    } else if (source.name === "HUG") {
      const bodyText = clean(await page.locator("body").innerText());
      const pdfs = page.locator('a[href*="jeonse_notice"][href$=".pdf"]:visible');
      for (let index = 0; index < await pdfs.count(); index += 1) {
        const pdf = pdfs.nth(index);
        items.push({ title: clean(await pdf.textContent()) || "HUG 든든전세주택 입주자 모집공고", url: await pdf.getAttribute("href"), rawText: bodyText });
      }
      items = items.filter((item) => /입주자 모집공고문/.test(item.title) && /\.pdf(?:$|\?)/.test(item.url));
      const totalText = await page.locator("span.total").first().textContent().catch(() => "");
      const dataRowCount = await page.locator("tbody tr").evaluateAll((rows) => rows.filter((row) => {
        const text = (row.textContent || "").replace(/\s+/g, " ").trim();
        const visible = row.getClientRects().length > 0 && getComputedStyle(row).visibility !== "hidden";
        return visible && text && !/등록된 게시물이 없습니다/.test(text);
      }).length);
      collectionState = classifyHugCollection({ bodyText, totalText, dataRowCount, notices: items });
      items = collectionState.notices;
    }

    if (collectionState.state !== "ok") return collectionState;

    const deduped = new Map();
    for (const item of items) {
      const title = clean(item.title);
      if (!title || title.length > 300 || closedWords.test(title)) continue;
      deduped.set(title, { ...item, title });
    }

    const results = [];
    for (const item of [...deduped.values()].slice(0, 30)) {
      let rawText = clean(item.rawText);
      if (/^https?:/.test(item.url) && !item.url.endsWith(".pdf") && item.url !== source.url && results.length < 12) {
        const detail = await context.newPage();
        try {
          const detailResponse = await detail.goto(item.url, { waitUntil: "domcontentloaded", timeout: 45_000 });
          if (detailResponse && detailResponse.status() < 400) {
            await detail.waitForTimeout(700);
            rawText = `${rawText} ${clean(await detail.locator("body").innerText())}`.slice(0, 50000);
          }
        } catch { /* list data remains usable */ }
        finally { await detail.close(); }
      }
      const dates = extractDates(`${item.title} ${rawText}`);
      const assessment = classify({ source: source.name, title: item.title, rawText, rules });
      results.push({
        source: source.name,
        title: item.title,
        url: item.url || source.url,
        rawText,
        location: source.name === "청년안심주택" ? "서울" : null,
        ...dates,
        ...assessment,
      });
    }
    if (!results.length) return { state: "error", notices: [], message: `${source.name} 검증된 공고를 만들지 못함` };
    return { state: "ok", notices: results };
  } finally {
    await page.close();
  }
}

export async function collectAll() {
  const rules = listHousingRules();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: "ko-KR", timezoneId: "Asia/Seoul" });
  const summary = [];
  try {
    try {
      const api = await collectMyHomeApi(rules);
      const changes = api.notices.map((notice) => upsertNoticeWithStatus(notice));
      const deactivatedCount = api.skipped ? 0 : markSourceCollectionComplete("마이홈 API", changes.map(({ id }) => id));
      summary.push({
        source: "마이홈 API", count: api.notices.length,
        newCount: changes.filter(({ change }) => change === "new").length,
        changedCount: changes.filter(({ change }) => change === "changed").length,
        deactivatedCount, skipped: api.skipped || undefined,
      });
    } catch (error) {
      summary.push({ source: "마이홈 API", count: 0, error: error.message });
    }
    for (const source of sources) {
      try {
        const collected = await collectSource(context, source, rules);
        if (collected.state === "error") throw new Error(collected.message);
        if (collected.state === "empty") {
          summary.push({ source: source.name, status: "empty", count: 0, newCount: 0, changedCount: 0,
            deactivatedCount: markSourceCollectionEmpty(source.name), message: collected.message });
          continue;
        }
        const notices = collected.notices;
        const changes = notices.map((notice) => upsertNoticeWithStatus(notice));
        const deactivatedCount = markSourceCollectionComplete(source.name, changes.map(({ id }) => id));
        summary.push({
          source: source.name, count: notices.length,
          newCount: changes.filter(({ change }) => change === "new").length,
          changedCount: changes.filter(({ change }) => change === "changed").length,
          deactivatedCount,
        });
      } catch (error) {
        summary.push({ source: source.name, count: 0, error: error.message });
      }
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
  } finally {
    await browser.close();
  }
  const completedAt = new Date().toISOString();
  setSetting("housing_collection_last_attempt_at", completedAt);
  setSetting("housing_collection_last_summary", JSON.stringify({ completedAt, summary }));
  if (summary.every((entry) => !entry.error && !entry.skipped)) {
    setSetting("housing_collection_last_success_at", completedAt);
  }
  return summary;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(await collectAll(), null, 2));
}
