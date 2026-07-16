import { setApplication, upsertNotice } from "../db.mjs";

const presets = {
  "sh-youth-2026-1": [
    "SH",
    "2026년 1차 청년 매입임대주택 입주자모집(2026.6.26.)",
    "https://www.i-sh.co.kr/app/lay2/program/S1T294C297/www/brd/m_247/view.do?multi_itm_seq=2&seq=307073",
    "2026-07-20",
  ],
};
const [source, title, url, announcementDate = ""] = presets[process.argv[2]] || process.argv.slice(2);
if (!source || !title || !url) {
  throw new Error("usage: node register-application.mjs <source> <title> <url> [announcement-date]");
}

const id = upsertNotice({
  source,
  title,
  url,
  announcementDate: announcementDate || null,
  verdict: "likely",
  categories: ["사용자가 신청한 공고"],
  reasons: ["사용자가 직접 신청 사실을 등록함"],
  rawText: title,
});
setApplication(id, "applied", {
  announcementDate: announcementDate || null,
  note: "사용자 직접 등록",
});
console.log(`registered ${id}`);
