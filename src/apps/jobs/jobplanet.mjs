import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { chromium } from "playwright";
import { normalizeCompanyName } from "./company-verification.mjs";

const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
const statePath = () => process.env.JOBPLANET_STORAGE_STATE_FILE || "/data/crawler/data/jobplanet-storage-state.json";

export function parseJobPlanetCompanyCard(text, requestedCompany) {
  const raw = clean(text);
  const normalized = normalizeCompanyName(requestedCompany);
  const ratingMatch = raw.match(/([0-5](?:\.\d)?)(?=(?:IT\/|제조|금융|서비스|유통|교육|미디어|건설|서울|경기|인천|부산|대구|대전|광주|울산))/);
  const employeeMatch = raw.match(/(\d[\d,]*)명/);
  if (!normalized || !ratingMatch || !employeeMatch) return null;
  return {
    company: requestedCompany,
    jobplanetRating: Number(ratingMatch[1]),
    employeeCount: Number(employeeMatch[1].replace(/,/g, "")),
    provenance: "jobplanet_authorized_session",
    verifiedAt: new Date().toISOString().slice(0, 10),
  };
}

async function ensureSignedIn(page, context) {
  await page.goto("https://www.jobplanet.co.kr/welcome/index", { waitUntil: "domcontentloaded", timeout: 60_000 });
  if (!/user-session\/sign-in/.test(page.url())) return;
  if (!process.env.JOBPLANET_ID || !process.env.JOBPLANET_PASSWORD) throw new Error("JOBPLANET_ID and JOBPLANET_PASSWORD are required to refresh the JobPlanet session");
  await page.goto("https://www.jobplanet.co.kr/user-session/sign-in?_nav=gb", { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.locator('input[name="email"]').fill(process.env.JOBPLANET_ID);
  await page.locator('input[name="password"]').fill(process.env.JOBPLANET_PASSWORD);
  await page.getByRole("button", { name: "이메일로 로그인" }).click();
  await page.waitForTimeout(3_000);
  if (/user-session\/sign-in/.test(page.url()) || /로그인 \| 잡플래닛/.test(await page.title())) throw new Error("JobPlanet login did not complete; complete any required verification manually");
  await mkdir(dirname(statePath()), { recursive: true });
  await context.storageState({ path: statePath() });
}

export async function lookupJobPlanetCompany(company) {
  const browser = await chromium.launch({ headless: false });
  try {
    const context = await browser.newContext({
      locale: "ko-KR", timezoneId: "Asia/Seoul",
      ...(existsSync(statePath()) ? { storageState: statePath() } : {}),
    });
    const page = await context.newPage();
    await ensureSignedIn(page, context);
    await page.goto(`https://www.jobplanet.co.kr/search?query=${encodeURIComponent(company)}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const cards = await page.locator('a[href*="/companies/"]').evaluateAll((items) => items.map((item) => ({ href: item.href, text: item.textContent || "" })).filter((item) => item.text.trim()));
    const key = normalizeCompanyName(company);
    const match = cards.find((card) => normalizeCompanyName(card.text).startsWith(key));
    const verification = match ? parseJobPlanetCompanyCard(match.text, company) : null;
    await context.close();
    return verification;
  } finally { await browser.close(); }
}

export function mergeCompanyVerifications(path, additions) {
  const current = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
  const merged = new Map(current.map((row) => [normalizeCompanyName(row.company), row]));
  for (const row of additions.filter(Boolean)) merged.set(normalizeCompanyName(row.company), row);
  writeFileSync(path, `${JSON.stringify([...merged.values()], null, 2)}\n`, { mode: 0o600 });
  return additions.filter(Boolean).length;
}
