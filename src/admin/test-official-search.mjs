import { searchOfficial } from "../apps/housing/official-tools.mjs";

const result = await searchOfficial(
  "LH",
  "서울관악봉천 H-1ㆍ2ㆍ3BL 행복주택 예비입주자 모집공고 2026.07.15",
);
console.log(JSON.stringify({
  url: result.url,
  matched: result.matched,
  text: result.text.slice(0, 2500),
}, null, 2));
