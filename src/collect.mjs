import { chromium } from "playwright";
import { listHousingRules, markSourceCollectionComplete, setSetting, upsertNoticeWithStatus } from "./db.mjs";
import { classify, extractDates } from "./classify.mjs";
import { collectMyHomeApi } from "./myhome-api.mjs";

const sources = [
  { name: "청년안심주택", url: "https://soco.seoul.go.kr/youth/bbs/BMSR00015/list.do?menuNo=400008" },
  { name: "HUG", url: "https://www.khug.or.kr/jeonse/web/s07/s070102.jsp" },
];

const clean = (value) => (value || "").replace(/\s+/g, " ").trim();
const noticeWords = /모집|입주자|예비입주자|청년주택|임대주택|든든전세|잔여세대/;
const closedWords = /당첨자|경쟁률|서류심사|발표|마감|공급완료/;

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

    if (source.name === "청년안심주택") {
      items = anchors.filter((item) => item.url.includes("BMSR00015/view.do"));
      const statusPage = await context.newPage();
      try {
        await statusPage.goto("https://soco.seoul.go.kr/youth/main/main.do", { waitUntil: "domcontentloaded", timeout: 45_000 });
        await statusPage.waitForTimeout(1500);
        const activeTexts = await statusPage.locator("a").evaluateAll((links) => links
          .map((link) => (link.textContent || "").replace(/\s+/g, " ").trim())
          .filter((text) => /청약중|청약예정/.test(text)));
        items = items.filter((item) => {
          const keywords = item.title
            .replace(/\[[^\]]+\]|최초모집공고|추가모집공고|모집공고/g, "")
            .split(/\s+/)
            .filter((word) => word.length >= 3 && !/역$|모집|민간임대/.test(word));
          return activeTexts.some((active) => keywords.some((word) => active.includes(word)));
        });
      } finally {
        await statusPage.close();
      }
    } else if (source.name === "HUG") {
      const bodyText = clean(await page.locator("body").innerText());
      const pdf = await page.locator('a[href*="jeonse_notice"][href$=".pdf"]').first();
      if (await pdf.count() && !/총\s*0건|등록된 게시물이 없습니다/.test(bodyText)) {
        items.push({
          title: clean(await pdf.textContent()) || "HUG 든든전세주택 입주자 모집공고",
          url: await pdf.getAttribute("href"),
          rawText: clean(await page.locator("body").innerText()),
        });
      }
      items = items.filter((item) => /입주자 모집공고문/.test(item.title) && /\.pdf(?:$|\?)/.test(item.url));
    }

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
    return results;
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
        const notices = await collectSource(context, source, rules);
        if (!notices.length) throw new Error(`${source.name} returned zero validated notices; prior active state retained`);
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
