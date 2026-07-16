const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const sites = [
    ["LH", "https://apply.lh.or.kr/lhapply/apply/wt/wrtanc/selectWrtancList.do"],
    ["SH", "https://www.i-sh.co.kr/app/lay2/program/S1T1C222/subMain4.do"],
  ];

  for (const [name, url] of sites) {
    try {
      const response = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      console.log(`${name} status=${response?.status()} title=${await page.title()}`);
    } catch (error) {
      console.log(`${name} error=${error.message}`);
    }
  }

  await browser.close();
})();
