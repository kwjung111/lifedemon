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
const allowedDomainSuffixes = [".lh.or.kr", ".i-sh.co.kr", ".seoul.go.kr", ".khug.or.kr", ".myhome.go.kr"];

export const sourceRoots = {
  LH: "https://apply.lh.or.kr/lhapply/apply/wt/wrtanc/selectWrtancList.do?mi=1026",
  SH: "https://www.i-sh.co.kr/app/lay2/program/S1T294C297/www/brd/m_247/list.do?multi_itm_seq=2",
  서울주거포털: "https://housing.seoul.go.kr/",
  청년안심주택: "https://soco.seoul.go.kr/youth/bbs/BMSR00015/list.do?menuNo=400008",
  HUG: "https://www.khug.or.kr/jeonse/web/s07/s070102.jsp",
  마이홈: "https://www.myhome.go.kr/hws/portal/main/getMgtMainHubPage.do",
};

const importantEvidence = /(?:신청자격|입주자격|공급대상|순위|소득|총자산|자동차|무주택|청약통장|선정방법|배점|임대조건|보증금|임대료|접수기간|신청기간|제출서류|당첨자)/;
const genericSearchWords = new Set(["공고", "모집", "모집공고", "주택", "입주자", "공급", "신청", "서울", "임대"]);

function checkedUrl(value) {
  const url = new URL(value);
  const officialHost = allowedHosts.includes(url.hostname) || allowedDomainSuffixes.some((suffix) => url.hostname.endsWith(suffix));
  if (url.protocol !== "https:" || !officialHost) {
    throw new Error(`official-domain allowlist rejected ${url.hostname}`);
  }
  return url;
}

async function fetchOfficial(value, options = {}) {
  let url = checkedUrl(value);
  for (let redirect = 0; redirect <= 5; redirect += 1) {
    const response = await fetch(url, { ...options, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) throw new Error(`official redirect ${response.status} has no location`);
    url = checkedUrl(new URL(location, url).href);
  }
  throw new Error("too many official redirects");
}

async function readLimitedBody(response, maxBytes = 25 * 1024 * 1024) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maxBytes) throw new Error(`official PDF exceeds ${maxBytes} bytes`);
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error(`official PDF exceeds ${maxBytes} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, size);
}

export function isPdfBytes(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value || []);
  return bytes.subarray(0, 5).toString("ascii") === "%PDF-";
}

async function guardOfficialRequests(target) {
  await target.route("**/*", async (route) => {
    const request = route.request();
    try {
      const requestUrl = new URL(request.url());
      if (["data:", "blob:", "about:"].includes(requestUrl.protocol)) return route.continue();
      checkedUrl(requestUrl.href);
      return route.continue();
    } catch {
      return route.abort("blockedbyclient");
    }
  });
}

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function decode(value) {
  try { return decodeURIComponent(value); } catch { return String(value || ""); }
}

function normalizeForMatch(value) {
  return clean(value).toLowerCase().replace(/[^0-9a-z가-힣]/g, "");
}

function searchWords(query) {
  return [...new Set(clean(query).split(/[\s()[\]{}<>·,:/\\_-]+/)
    .map((word) => word.replace(/[^0-9a-zA-Z가-힣]/g, ""))
    .filter((word) => word.length >= 2 && !genericSearchWords.has(word)))].slice(0, 12);
}

export function rankOfficialCandidates(query, candidates = []) {
  const words = searchWords(query);
  const normalizedQuery = normalizeForMatch(query);
  const ranked = candidates.map((candidate, index) => {
    const text = clean(candidate.text);
    const normalizedText = normalizeForMatch(text);
    const matchedWords = words.filter((word) => normalizedText.includes(normalizeForMatch(word)));
    const coverage = words.length ? matchedWords.length / words.length : 0;
    const exact = normalizedQuery.length >= 8 && normalizedText.includes(normalizedQuery);
    const score = matchedWords.reduce((sum, word) => sum + Math.min(12, word.length), 0) + (exact ? 30 : 0);
    return { ...candidate, index: candidate.index ?? index, matchedWords, coverage, exact, score };
  }).sort((a, b) => b.score - a.score || b.coverage - a.coverage);
  const best = ranked[0] || null;
  // One generic/common word must never navigate to a seemingly related but different notice.
  const longestWordLength = Math.max(0, ...words.map((word) => word.length));
  const hasDistinctiveWord = Boolean(best?.matchedWords.some((word) => word.length === longestWordLength));
  const accepted = Boolean(best && (best.exact || (hasDistinctiveWord && best.matchedWords.length >= 2 && best.coverage >= 0.7)));
  return {
    words,
    best,
    accepted,
    confidence: !best ? "none" : best.exact ? "high" : accepted && best.coverage >= 0.7 ? "high" : accepted ? "medium" : "low",
  };
}

export function classifyOfficialLink(link) {
  const label = clean(link?.text);
  let url;
  try { url = checkedUrl(link?.href); } catch { return { ...link, official: false, attachmentKind: "rejected" }; }
  const onclick = clean(link?.onclick);
  const haystack = decode(`${url.pathname} ${url.search} ${label} ${onclick}`).toLowerCase();
  let attachmentKind = "page";
  if (/\.pdf(?:\b|$)|\bpdf\b/.test(haystack)) attachmentKind = "pdf";
  else if (/\.hwp[x]?(?:\b|$)|\b한글\b/.test(haystack)) attachmentKind = "hwp";
  else if (/\.docx?(?:\b|$)/.test(haystack)) attachmentKind = "word";
  else if (/\.xlsx?(?:\b|$)/.test(haystack)) attachmentKind = "spreadsheet";
  else if (/첨부|다운로드|download|filedown/.test(haystack)) attachmentKind = "download";
  const relevance = (/(모집공고|공고문|입주자모집)/.test(label) ? 3 : 0)
    + (attachmentKind === "pdf" ? 2 : attachmentKind !== "page" ? 1 : 0)
    - (/(정정|당첨|결과|FAQ|서식|양식)/.test(label) ? 2 : 0);
  const interactionRequired = attachmentKind !== "page" && Boolean(onclick) && !/\.pdf|\.hwp[x]?|\.docx?|\.xlsx?|download|filedown/i.test(`${url.pathname} ${url.search}`);
  return { ...link, href: url.href, official: true, attachmentKind, relevance, interactionRequired };
}

export function selectEvidenceText(fullText, maxChars = 30_000) {
  const text = String(fullText || "").replace(/\r/g, "").trim();
  const pages = text.split(/\f+/).map((page) => page.trim()).filter(Boolean);
  if (text.length <= maxChars) {
    return { text, truncated: false, totalChars: text.length, totalPages: pages.length || (text ? 1 : 0), selectedPages: pages.map((_, i) => i + 1) };
  }

  if (pages.length > 1) {
    const estimatedCapacity = Math.max(1, Math.floor(maxChars / Math.max(1_000, Math.min(5_000, text.length / pages.length))));
    const spread = (items, count) => {
      if (items.length <= count) return items;
      return Array.from({ length: count }, (_, index) => items[Math.round(index * (items.length - 1) / Math.max(1, count - 1))]);
    };
    const importantPages = pages.map((page, index) => importantEvidence.test(page) ? index : -1).filter((index) => index >= 0);
    const anchors = [0, pages.length - 1].filter((index) => index >= 0 && index < pages.length);
    const remaining = Math.max(0, estimatedCapacity - new Set(anchors).size);
    const importantSlots = Math.min(importantPages.length, Math.ceil(remaining * 0.65));
    const selected = [...new Set([
      ...anchors,
      ...spread(importantPages, importantSlots),
      ...spread(pages.map((_, index) => index), Math.max(0, remaining - importantSlots)),
    ])].slice(0, estimatedCapacity).sort((a, b) => a - b);
    const pieces = [];
    let used = 0;
    const included = [];
    for (const index of selected) {
      const header = `\n[PDF ${index + 1}/${pages.length}쪽]\n`;
      const available = maxChars - used - header.length;
      if (available < 300) break;
      const page = pages[index].slice(0, available);
      pieces.push(header + page);
      included.push(index + 1);
      used += header.length + page.length;
    }
    return { text: pieces.join("").trim(), truncated: true, totalChars: text.length, totalPages: pages.length, selectedPages: included };
  }

  const windows = [{ start: 0, end: 5_000 }, { start: Math.max(0, text.length - 4_000), end: text.length }];
  for (const match of text.matchAll(new RegExp(importantEvidence.source, "g"))) {
    windows.push({ start: Math.max(0, match.index - 900), end: Math.min(text.length, match.index + 1_800) });
  }
  for (let i = 1; i < 7; i += 1) {
    const center = Math.floor(text.length * i / 7);
    windows.push({ start: Math.max(0, center - 500), end: Math.min(text.length, center + 500) });
  }
  windows.sort((a, b) => a.start - b.start);
  const merged = windows.reduce((items, window) => {
    const last = items.at(-1);
    if (last && window.start <= last.end + 100) last.end = Math.max(last.end, window.end);
    else items.push({ ...window });
    return items;
  }, []);
  let output = "";
  for (const window of merged) {
    const marker = `\n[PDF 문자 ${window.start + 1}-${window.end}]\n`;
    const available = maxChars - output.length - marker.length;
    if (available < 300) break;
    output += marker + text.slice(window.start, window.start + available);
  }
  return { text: output.trim(), truncated: true, totalChars: text.length, totalPages: text ? 1 : 0, selectedPages: [1] };
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

function commandAvailable(command, args = ["-v"]) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 5_000 });
  return !result.error && result.status === 0;
}

function pdfPageCount(pdfPath) {
  const result = spawnSync("pdfinfo", [pdfPath], { encoding: "utf8", timeout: 10_000 });
  const match = result.status === 0 ? result.stdout.match(/^Pages:\s+(\d+)/m) : null;
  return match ? Number(match[1]) : 0;
}

export function selectOcrPages(totalPages, limit = 12) {
  if (!Number.isFinite(totalPages) || totalPages <= 0) return Array.from({ length: limit }, (_, index) => index + 1);
  if (totalPages <= limit) return Array.from({ length: totalPages }, (_, index) => index + 1);
  const pages = [1, 2, 3, 4, totalPages - 1, totalPages];
  const remaining = limit - pages.length;
  for (let index = 1; index <= remaining; index += 1) {
    pages.push(Math.round((totalPages - 1) * index / (remaining + 1)) + 1);
  }
  return [...new Set(pages)].sort((a, b) => a - b).slice(0, limit);
}

export function hasCompleteOcrCoverage(ocr, totalPages) {
  return Boolean(
    ocr?.attempted
    && Number.isFinite(totalPages)
    && totalPages > 0
    && Array.isArray(ocr.successfulPages)
    && ocr.successfulPages.length === totalPages,
  );
}

function runOcr(pdfPath, cacheDir, hash) {
  const available = commandAvailable("pdftoppm", ["-v"]) && commandAvailable("tesseract", ["--version"]);
  if (!available) return { text: "", attempted: false, available: false, reason: "pdftoppm/tesseract not installed" };
  const totalPages = pdfPageCount(pdfPath);
  const selectedPages = selectOcrPages(totalPages);
  const pages = [];
  const successfulPages = [];
  for (const page of selectedPages) {
    const prefix = `${cacheDir}/${hash}-ocr-${page}`;
    const image = `${prefix}.jpg`;
    const rendered = spawnSync("pdftoppm", ["-f", String(page), "-l", String(page), "-singlefile", "-r", "180", "-jpeg", pdfPath, prefix], { encoding: "utf8", timeout: 30_000 });
    if (rendered.status !== 0) continue;
    const ocr = spawnSync("tesseract", [image, "stdout", "-l", "kor+eng"], { encoding: "utf8", timeout: 45_000 });
    if (ocr.status === 0 && clean(ocr.stdout)) {
      pages.push(`[OCR 원본 ${page}/${totalPages || "?"}쪽]\n${ocr.stdout}`);
      successfulPages.push(page);
    }
  }
  return {
    text: pages.join("\f"), attempted: true, available: true,
    reason: pages.length ? null : "OCR returned no usable text",
    pageLimit: 12, totalPages, selectedPages, successfulPages,
  };
}

async function readPdf(url) {
  const response = await fetchOfficial(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`PDF HTTP ${response.status}`);
  checkedUrl(response.url);
  const cacheDir = process.env.HOUSING_AGENT_CACHE || "/data/crawler/data/agent-cache";
  mkdirSync(cacheDir, { recursive: true });
  const hash = createHash("sha256").update(url).digest("hex").slice(0, 20);
  const pdfPath = `${cacheDir}/${hash}.pdf`;
  const textPath = `${cacheDir}/${hash}.txt`;
  const pdfBytes = await readLimitedBody(response);
  if (!isPdfBytes(pdfBytes)) throw new Error("official attachment is not a PDF");
  writeFileSync(pdfPath, pdfBytes, { mode: 0o600 });
  const converted = spawnSync("pdftotext", ["-layout", pdfPath, textPath], { encoding: "utf8", timeout: 60_000 });
  let fullText = converted.status === 0 ? readFileSync(textPath, "utf8") : "";
  const totalPages = pdfPageCount(pdfPath);
  let method = "pdftotext";
  let ocr = { attempted: false, available: null, reason: null };
  const sparseText = clean(fullText).length < 800
    || (totalPages > 1 && clean(fullText).length / totalPages < 150);
  if (sparseText) {
    ocr = runOcr(pdfPath, cacheDir, hash);
    if (clean(ocr.text).length > clean(fullText).length) {
      fullText = ocr.text;
      method = "ocr";
    }
  }
  const selected = selectEvidenceText(fullText);
  const sufficient = clean(selected.text).length >= 800;
  const incompleteOcr = sparseText && !hasCompleteOcrCoverage(ocr, totalPages);
  return {
    url,
    text: selected.text,
    links: [],
    note: sufficient ? "PDF" : "PDF evidence insufficient",
    evidence: {
      status: sufficient && !incompleteOcr ? "available" : incompleteOcr ? "partial" : "insufficient",
      reason: incompleteOcr
        ? (ocr.attempted
          ? `OCR succeeded on ${ocr.successfulPages?.length || 0} of ${totalPages || "unknown"} pages`
          : ocr.reason || "OCR unavailable for sparse PDF")
        : sufficient ? null : (ocr.reason || "PDF contains too little extractable text"),
      method,
      totalChars: selected.totalChars,
      totalPages: Math.max(totalPages, selected.totalPages),
      selectedPages: method === "ocr" ? ocr.successfulPages : selected.selectedPages,
      truncated: selected.truncated,
      ocr: {
        attempted: ocr.attempted, available: ocr.available,
        pageLimit: ocr.pageLimit || null, totalPages: ocr.totalPages || totalPages || null,
        selectedPages: ocr.selectedPages || [], successfulPages: ocr.successfulPages || [],
      },
    },
  };
}

function looksLikePdfUrl(url) {
  try { return /\.pdf(?:\b|$)/i.test(decode(new URL(url).href)); } catch { return false; }
}

function looksLikeDownloadUrl(url) {
  try { return /download|filedown|atchfile|첨부/i.test(decode(new URL(url).href)); } catch { return false; }
}

async function looksLikePdfResponse(url) {
  try {
    const response = await fetchOfficial(url, { method: "HEAD", signal: AbortSignal.timeout(15_000) });
    const contentType = response.headers.get("content-type") || "";
    const disposition = decode(response.headers.get("content-disposition") || "");
    return /application\/pdf/i.test(contentType) || /filename[^;]*\.pdf/i.test(disposition);
  } catch {
    return false;
  }
}

async function hasPdfMagic(url) {
  try {
    const response = await fetchOfficial(url, {
      headers: { Range: "bytes=0-7" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok || !response.body) return false;
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (size < 8) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      size += value.byteLength;
    }
    await reader.cancel();
    return isPdfBytes(Buffer.concat(chunks, size));
  } catch {
    return false;
  }
}

function extractPage(page) {
  return Promise.all([
    page.locator("body").innerText(),
    page.locator("a").evaluateAll((anchors) => anchors.map((anchor) => ({
      text: (anchor.textContent || "").replace(/\s+/g, " ").trim(),
      href: anchor.href,
      onclick: anchor.getAttribute("onclick") || "",
    }))),
  ]).then(([body, rawLinks]) => {
    const links = rawLinks.map(classifyOfficialLink).filter((link) => link.official)
      .sort((a, b) => b.relevance - a.relevance).slice(0, 120);
    return { text: clean(body).slice(0, 30_000), links };
  });
}

export async function openOfficial(value) {
  const url = checkedUrl(value);
  if (looksLikePdfUrl(url.href)
      || looksLikeDownloadUrl(url.href)
      || await looksLikePdfResponse(url.href)
      || await hasPdfMagic(url.href)) {
    return readPdf(url.href);
  }
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ locale: "ko-KR", timezoneId: "Asia/Seoul", serviceWorkers: "block" });
    await guardOfficialRequests(context);
    const page = await context.newPage();
    const response = await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
    if (!response || response.status() >= 400) throw new Error(`HTTP ${response?.status()}`);
    checkedUrl(page.url());
    await page.waitForTimeout(1200);
    const extracted = await extractPage(page);
    return {
      url: page.url(), ...extracted, note: "HTML",
      evidence: { status: clean(extracted.text).length >= 300 ? "available" : "insufficient", reason: clean(extracted.text).length >= 300 ? null : "official page contains too little text", method: "html" },
    };
  } finally {
    await browser.close();
  }
}

export async function searchOfficial(source, query) {
  const root = sourceRoots[source];
  if (!root) throw new Error(`unsupported official source ${source}`);
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ locale: "ko-KR", timezoneId: "Asia/Seoul", serviceWorkers: "block" });
    await guardOfficialRequests(context);
    const page = await context.newPage();
    const response = await page.goto(root, { waitUntil: "domcontentloaded", timeout: 60_000 });
    if (!response || response.status() >= 400) throw new Error(`HTTP ${response?.status()}`);
    checkedUrl(page.url());
    await page.waitForTimeout(1200);
    const candidates = await page.locator("a").evaluateAll((anchors) => anchors.map((anchor, index) => ({
      index, text: (anchor.textContent || "").replace(/\s+/g, " ").trim(), href: anchor.href,
    })));
    const match = rankOfficialCandidates(query, candidates);
    let navigated = false;
    let detailPage = page;
    if (match.accepted) {
      const anchor = page.locator("a").nth(match.best.index);
      await anchor.scrollIntoViewIfNeeded().catch(() => {});
      const before = page.url();
      const popupPromise = page.waitForEvent("popup", { timeout: 3_000 }).catch(() => null);
      const clicked = await anchor.click({ timeout: 15_000 }).then(() => true).catch(() => false);
      if (clicked) {
        await page.waitForTimeout(1800);
        navigated = page.url() !== before;
        const popup = await popupPromise;
        if (popup) {
          await popup.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
          detailPage = popup;
          navigated = true;
        }
      }
      if (!navigated && match.best.href && match.best.href !== before) {
        try {
          const direct = checkedUrl(match.best.href);
          const directResponse = await page.goto(direct.href, { waitUntil: "domcontentloaded", timeout: 30_000 });
          navigated = Boolean(directResponse && directResponse.status() < 400 && page.url() !== before);
        } catch { /* preserve candidate_found */ }
      }
    }
    const current = checkedUrl(detailPage.url());
    const extracted = await extractPage(detailPage);
    const usableDetail = navigated && clean(extracted.text).length >= 300;
    return {
      source, query, url: current.href,
      matched: match.accepted ? match.best.text : null,
      match: { status: !match.accepted ? "not_matched" : navigated ? "matched" : "candidate_found", confidence: match.confidence, candidate: match.best?.text || null, candidateUrl: match.best?.href || null, matchedWords: match.best?.matchedWords || [], coverage: match.best?.coverage || 0 },
      ...extracted,
      evidence: {
        status: usableDetail ? "available" : "discovery_incomplete",
        reason: usableDetail ? null
          : navigated ? "official detail page contains too little text"
            : match.accepted ? "specific candidate found but official detail page was not opened"
              : "no sufficiently specific official notice title match",
        method: "official_search",
      },
    };
  } finally {
    await browser.close();
  }
}

export async function fulfillNeeds(needs = []) {
  const results = [];
  for (const need of needs.slice(0, 2)) {
    try {
      let result = null;
      if (need.type === "open" && need.url) result = await openOfficial(need.url);
      else if (need.type === "search" && need.source && need.query) result = await searchOfficial(need.source, need.query);
      if (result) results.push({ request: need, status: "completed", evidenceStatus: result.evidence?.status || "unknown", result });
      else results.push({ request: need, status: "invalid_request", evidenceStatus: "not_attempted", failure: { stage: "request_validation", message: "unsupported or incomplete evidence request" } });
    } catch (error) {
      results.push({ request: need, status: "discovery_failed", evidenceStatus: "unavailable", failure: { stage: need.type === "search" ? "official_search" : "official_open", message: error.message }, error: error.message });
    }
  }
  return results;
}
