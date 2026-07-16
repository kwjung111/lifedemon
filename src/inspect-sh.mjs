import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ locale: "ko-KR" });
await page.goto("https://www.i-sh.co.kr/app/lay2/program/S1T294C297/www/brd/m_247/list.do?multi_itm_seq=2", {
  waitUntil: "domcontentloaded",
  timeout: 60000,
});
await page.waitForTimeout(2000);
if (process.argv[2]) {
  await page.goto(`https://www.i-sh.co.kr/app/lay2/program/S1T294C297/www/brd/m_247/view.do?multi_itm_seq=2&seq=${process.argv[2]}`, {
    waitUntil: "domcontentloaded", timeout: 60000,
  });
  await page.waitForTimeout(1500);
  console.log((await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 12000));
  await browser.close();
  process.exit(0);
}
const rows = await page.locator("table tr").evaluateAll((items) => items.map((row) => ({
  text: (row.textContent || "").replace(/\s+/g, " ").trim(),
  links: [...row.querySelectorAll("a")].map((a) => ({
    text: (a.textContent || "").replace(/\s+/g, " ").trim(),
    href: a.getAttribute("href"),
    onclick: a.getAttribute("onclick"),
  })),
})).filter((row) => /입주자|모집/.test(row.text)).slice(0, 10));
console.log(JSON.stringify(rows, null, 2));
console.log(await page.evaluate(() => typeof getDetailView === "function" ? getDetailView.toString() : "missing"));
await browser.close();
