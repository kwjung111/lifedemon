import { resolve } from "node:path";
import { chromium } from "playwright";
import { detectWantedSession, saveWantedSession } from "../apps/jobs/wanted-session.mjs";

const outputPath = resolve(process.argv[2] || process.env.WANTED_STORAGE_STATE_FILE || "./data/wanted-storage-state.json");
const timeoutMs = 30 * 60_000;
const browser = await chromium.launch({ headless: false });

try {
  const context = await browser.newContext({ locale: "ko-KR", timezoneId: "Asia/Seoul" });
  const page = await context.newPage();
  await page.goto("https://www.wanted.co.kr/login", { waitUntil: "domcontentloaded", timeout: 60_000 });
  console.log("원티드 로그인 창에서 가입과 로그인을 완료해 주세요. 최대 30분 동안 기다립니다.");

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const candidate of context.pages()) {
      if (await detectWantedSession(candidate) === "signed_in") {
        await saveWantedSession(context, outputPath);
        console.log(`WANTED_AUTHORIZED ${outputPath}`);
        await context.close();
        process.exitCode = 0;
        break;
      }
    }
    if (process.exitCode === 0) break;
    await page.waitForTimeout(1_000);
  }

  if (process.exitCode !== 0) throw new Error("원티드 로그인이 30분 안에 확인되지 않았습니다.");
} finally {
  await browser.close();
}
