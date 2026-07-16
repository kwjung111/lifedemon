import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chromium } from "playwright";

const allowedHosts = [
  "apply.lh.or.kr",
  "www.i-sh.co.kr",
  "housing.seoul.go.kr",
  "soco.seoul.go.kr",
  "www.khug.or.kr",
  "www.myhome.go.kr",
];

export const sourceRoots = {
  LH: "https://apply.lh.or.kr/lhapply/apply/wt/wrtanc/selectWrtancList.do?mi=1026",
  SH: "https://www.i-sh.co.kr/app/lay2/program/S1T294C297/www/brd/m_247/list.do?multi_itm_seq=2",
  서울주거포털: "https://housing.seoul.go.kr/",
  청년안심주택: "https://soco.seoul.go.kr/youth/bbs/BMSR00015/list.do?menuNo=400008",
  HUG: "https://www.khug.or.kr/jeonse/web/s07/s070102.jsp",
  마이홈: "https://www.myhome.go.kr/hws/portal/main/getMgtMainHubPage.do",
};

function checkedUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || !allowedHosts.includes(url.hostname)) {
    throw new Error(`official-domain allowlist rejected ${url.hostname}`);
  }
  return url;
}

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function officialSearchSource(source, rawText = "") {
  if (source !== "마이홈 API") return source;
  try {
    const parsed = JSON.parse(rawText || "{}");
    const item = Array.isArray(parsed) ? parsed[0] : parsed;
    const provider = clean(item?.suplyInsttNm).toUpperCase();
    if (provider.includes("LH")) return "LH";
    if (provider.includes("SH")) return "SH";
  } catch { /* fall back to MyHome */ }
  return "마이홈";
}

async function readPdf(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`PDF HTTP ${response.status}`);
  const cacheDir = process.env.HOUSING_AGENT_CACHE || "/data/crawler/data/agent-cache";
  mkdirSync(cacheDir, { recursive: true });
  const hash = createHash("sha256").update(url).digest("hex").slice(0, 20);
  const pdfPath = `${cacheDir}/${hash}.pdf`;
  const textPath = `${cacheDir}/${hash}.txt`;
  writeFileSync(pdfPath, Buffer.from(await response.arrayBuffer()), { mode: 0o600 });
  const converted = spawnSync("pdftotext", ["-layout", pdfPath, textPath], { encoding: "utf8", timeout: 60_000 });
  if (converted.status !== 0) return { url, text: "", links: [], note: "PDF text extraction unavailable" };
  return { url, text: readFileSync(textPath, "utf8").slice(0, 30000), links: [], note: "PDF" };
}

export async function openOfficial(value) {
  const url = checkedUrl(value);
  if (/\.pdf(?:$|\?)/i.test(url.href)) return readPdf(url.href);

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ locale: "ko-KR", timezoneId: "Asia/Seoul" });
    const response = await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
    if (!response || response.status() >= 400) throw new Error(`HTTP ${response?.status()}`);
    await page.waitForTimeout(1200);
    const text = clean(await page.locator("body").innerText()).slice(0, 30000);
    const links = await page.locator("a").evaluateAll((anchors) => anchors.map((anchor) => ({
      text: (anchor.textContent || "").replace(/\s+/g, " ").trim(),
      href: anchor.href,
      onclick: anchor.getAttribute("onclick") || "",
    })));
    return {
      url: page.url(),
      text,
      links: links.filter((link) => {
        try { return allowedHosts.includes(new URL(link.href).hostname); } catch { return false; }
      }).slice(0, 80),
      note: "HTML",
    };
  } finally {
    await browser.close();
  }
}

export async function searchOfficial(source, query) {
  const root = sourceRoots[source];
  if (!root) throw new Error(`unsupported official source ${source}`);
  const keywords = clean(query).split(" ").filter((word) => word.length >= 2).slice(0, 8);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ locale: "ko-KR", timezoneId: "Asia/Seoul" });
    await page.goto(root, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(1200);
    const candidates = await page.locator("a").evaluateAll((anchors, words) => anchors.map((anchor, index) => {
      const text = (anchor.textContent || "").replace(/\s+/g, " ").trim();
      return { index, text, score: words.filter((word) => text.includes(word)).length };
    }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score), keywords);
    const best = candidates[0];
    if (best && best.score >= Math.min(3, keywords.length)) {
      const anchor = page.locator("a").nth(best.index);
      await anchor.scrollIntoViewIfNeeded().catch(() => {});
      await anchor.click({ timeout: 15_000 }).catch(() => {});
      await page.waitForTimeout(1800);
    }
    const current = checkedUrl(page.url());
    const text = clean(await page.locator("body").innerText()).slice(0, 30000);
    const links = await page.locator("a").evaluateAll((anchors) => anchors.map((anchor) => ({
      text: (anchor.textContent || "").replace(/\s+/g, " ").trim(),
      href: anchor.href,
    }))).then((items) => items.filter((item) => {
      try { return allowedHosts.includes(new URL(item.href).hostname); } catch { return false; }
    }).slice(0, 80));
    return { source, query, url: current.href, matched: best?.text || null, links, text };
  } finally {
    await browser.close();
  }
}

export async function fulfillNeeds(needs = []) {
  const results = [];
  for (const need of needs.slice(0, 2)) {
    try {
      if (need.type === "open" && need.url) {
        results.push({ request: need, result: await openOfficial(need.url) });
      } else if (need.type === "search" && need.source && need.query) {
        results.push({ request: need, result: await searchOfficial(need.source, need.query) });
      }
    } catch (error) {
      results.push({ request: need, error: error.message });
    }
  }
  return results;
}
