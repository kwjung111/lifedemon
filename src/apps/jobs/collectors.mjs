import { chromium } from "playwright";

const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();

// Public listing/detail routes only. No login, personal pages, saved jobs, or apply flows.
export const publicJobSources = [
  {
    name: "remember", detailPath: /\/job\/posting\/\d+/,
    listUrl(query) {
      const search = JSON.stringify({ includeAppliedJobPosting: false, leaderPosition: false, organizationType: "all", applicationType: "all", keywords: [query] });
      return `https://career.rememberapp.co.kr/job/postings?search=${encodeURIComponent(search)}`;
    },
  },
  {
    name: "wanted", listUrl: () => "https://www.wanted.co.kr/wdlist?country=kr&job_sort=job.latest_order",
    detailPath: /\/wd\/\d+/, requiresSession: true,
  },
  { name: "jobkorea", listUrl: () => "https://www.jobkorea.co.kr/recruit/joblist", detailPath: /\/Recruit\/GI_Read\//i },
];

export function linksForSource(source, anchors, query = "") {
  const seen = new Set();
  const normalizedQuery = clean(query).toLowerCase();
  return anchors
    .filter((anchor) => source.detailPath.test(anchor.href) && clean(anchor.text).length >= 2)
    .filter((anchor) => !normalizedQuery || clean(anchor.text).toLowerCase().includes(normalizedQuery))
    .filter((anchor) => {
      if (seen.has(anchor.href)) return false;
      seen.add(anchor.href);
      return true;
    })
    .slice(0, 100);
}

export function normalizePublicJob(source, detail) {
  const title = clean(detail.title);
  const company = clean(detail.company);
  if (!title || !company || !detail.url) return null;
  return {
    source: source.name,
    externalId: detail.url.match(/\/(?:posting|wd)\/(\d+)/i)?.[1] || null,
    company, title, url: detail.url,
    location: clean(detail.location) || null,
    experience: clean(detail.experience) || null,
    rawText: clean(detail.rawText),
  };
}

export function inferCompany(sourceName, pageTitle, rawText = "") {
  const title = clean(pageTitle).replace(/\s*[|｜]\s*(원티드|잡코리아|리멤버).*$/i, "");
  if (sourceName === "remember") return clean(title.match(/^(.+?)\s+채용\s*[|｜]/)?.[1]);
  if (sourceName === "wanted") return clean(title.split(/\s+-\s+/)[0]);
  if (sourceName === "jobkorea") return clean(title.match(/^(.+?)\s+채용\s*[-|｜]/)?.[1]);
  return clean(rawText.split(/\n+/)[0]);
}

export function inferJobMetadata(bodyText) {
  const lines = String(bodyText || "").split(/\r?\n/).map(clean).filter(Boolean);
  return {
    location: lines.find((line) => line.length <= 120 && /서울|경기|인천|부산|대구|대전|광주|울산|세종|강원|충북|충남|전북|전남|경북|경남|제주/.test(line)) || null,
    experience: lines.find((line) => line.length <= 120 && /신입|경력|년 이상|년 이하|무관/.test(line)) || null,
  };
}

async function anchorsOn(page) {
  return page.locator("a").evaluateAll((anchors) => anchors.map((anchor) => ({
    text: (anchor.textContent || "").replace(/\s+/g, " ").trim(), href: anchor.href,
  })));
}

async function extractDetail(page, href, source) {
  const response = await page.goto(href, { waitUntil: "domcontentloaded", timeout: 45_000 });
  if (!response || response.status() >= 400) throw new Error(`${source.name} detail HTTP ${response?.status()}`);
  await page.waitForTimeout(600);
  const bodyText = await page.locator("body").innerText();
  const rawText = clean(bodyText).slice(0, 60_000);
  const pageTitle = clean(await page.locator('meta[property="og:title"]').getAttribute("content").catch(() => "")) || clean(await page.title());
  // Do not guess from arbitrary body text: an unknown company is safer than an incorrect pass.
  const company = inferCompany(source.name, pageTitle, rawText);
  const title = clean(await page.locator("h1").first().textContent().catch(() => "")) || clean(await page.title());
  const metadata = inferJobMetadata(bodyText);
  return normalizePublicJob(source, { url: page.url(), company, title, rawText,
    ...metadata,
  });
}

export async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function runWorker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, runWorker));
  return results;
}

export async function collectPublicJobSource(source, { query = "", maxDetails = 50, detailConcurrency = 4 } = {}) {
  if (source.requiresSession && !process.env.WANTED_STORAGE_STATE_FILE) {
    throw new Error("wanted requires WANTED_STORAGE_STATE_FILE from an already logged-in session");
  }
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      locale: "ko-KR", timezoneId: "Asia/Seoul", serviceWorkers: "block",
      ...(source.requiresSession ? { storageState: process.env.WANTED_STORAGE_STATE_FILE } : {}),
    });
    const page = await context.newPage();
    const response = await page.goto(source.listUrl(query), { waitUntil: "domcontentloaded", timeout: 60_000 });
    if (!response || response.status() >= 400) throw new Error(`${source.name} listing HTTP ${response?.status()}`);
    await page.waitForTimeout(1_000);
    const links = linksForSource(source, await anchorsOn(page), query);
    const details = await mapWithConcurrency(links.slice(0, maxDetails), detailConcurrency, async (link) => {
      const detail = await context.newPage();
      try {
        return await extractDetail(detail, link.href, source);
      } catch { /* One bad detail must not make the whole source look empty. */ }
      finally { await detail.close(); }
      return null;
    });
    const jobs = details.filter(Boolean);
    await context.close();
    if (!jobs.length) throw new Error(`${source.name} returned no readable public details`);
    return jobs;
  } finally { await browser.close(); }
}

export async function collectAllPublicJobSources({ queries = [""], ...options } = {}) {
  const results = [];
  for (const source of publicJobSources) {
    const merged = new Map();
    const errors = [];
    for (const query of queries) {
      try {
        for (const job of await collectPublicJobSource(source, { ...options, query })) merged.set(job.url, job);
      } catch (error) { errors.push(`${query || "all"}: ${error.message}`); }
    }
    results.push({ source: source.name, jobs: [...merged.values()], error: merged.size ? null : errors.join(" | ") || "no readable public details" });
  }
  return results;
}
