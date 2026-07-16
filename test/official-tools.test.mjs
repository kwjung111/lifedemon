import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyOfficialLink,
  hasCompleteOcrCoverage,
  isPdfBytes,
  officialSearchSource,
  rankOfficialCandidates,
  selectEvidenceText,
  selectOcrPages,
} from "../src/apps/housing/official-tools.mjs";

test("maps MyHome API notices back to the supplying institution", () => {
  assert.equal(officialSearchSource("마이홈 API", JSON.stringify({ suplyInsttNm: "LH" })), "LH");
  assert.equal(officialSearchSource("마이홈 API", JSON.stringify([{ suplyInsttNm: "SH서울주택도시공사" }])), "SH");
  assert.equal(officialSearchSource("마이홈 API", "invalid"), "마이홈");
  assert.equal(officialSearchSource("HUG", ""), "HUG");
});

test("rejects ambiguous official-search matches instead of opening a different notice", () => {
  const result = rankOfficialCandidates("2026 관악봉천 행복주택 입주자 모집공고", [
    { text: "2026 행복주택 모집공고" },
    { text: "관악구 청년주택 안내" },
  ]);
  assert.equal(result.accepted, false);
  assert.equal(result.confidence, "low");
});

test("accepts a specific title match and reports the matching evidence", () => {
  const result = rankOfficialCandidates("2026 관악봉천 행복주택 입주자 모집공고", [
    { text: "2026년 관악봉천 행복주택 입주자 모집공고" },
    { text: "2026년 강남 행복주택 입주자 모집공고" },
  ]);
  assert.equal(result.accepted, true);
  assert.equal(result.best.text, "2026년 관악봉천 행복주택 입주자 모집공고");
  assert.ok(result.best.matchedWords.includes("관악봉천"));
});

test("classifies only allowlisted official attachments and prioritizes the notice PDF", () => {
  const notice = classifyOfficialLink({ text: "입주자 모집공고문 PDF", href: "https://apply.lh.or.kr/files/notice.pdf" });
  const form = classifyOfficialLink({ text: "신청 양식", href: "https://apply.lh.or.kr/files/form.hwp" });
  const cdn = classifyOfficialLink({ text: "공고문", href: "https://file.i-sh.co.kr/notices/notice.pdf" });
  const rejected = classifyOfficialLink({ text: "공고문", href: "https://example.com/notice.pdf" });
  assert.equal(notice.attachmentKind, "pdf");
  assert.ok(notice.relevance > form.relevance);
  assert.equal(form.attachmentKind, "hwp");
  assert.equal(cdn.official, true);
  assert.equal(rejected.official, false);
});

test("samples long PDFs across pages and keeps eligibility sections", () => {
  const pages = Array.from({ length: 20 }, (_, index) => {
    const heading = index === 12 ? "신청자격 소득 총자산 무주택 선정방법" : `일반 안내 ${index + 1}`;
    return `${heading}\n${String(index + 1).repeat(2_000)}`;
  });
  const selected = selectEvidenceText(pages.join("\f"), 12_000);
  assert.equal(selected.truncated, true);
  assert.equal(selected.totalPages, 20);
  assert.ok(selected.selectedPages.includes(13));
  assert.match(selected.text, /신청자격 소득 총자산/);
  assert.match(selected.text, /PDF 20\/20쪽/);
  assert.ok(selected.text.length <= 12_000);
});

test("keeps full PDF text when it fits the evidence budget", () => {
  const selected = selectEvidenceText("첫 페이지\f마지막 페이지", 1_000);
  assert.equal(selected.truncated, false);
  assert.equal(selected.totalPages, 2);
  assert.deepEqual(selected.selectedPages, [1, 2]);
});

test("samples OCR pages across the full PDF instead of only its beginning", () => {
  const pages = selectOcrPages(60, 12);
  assert.equal(pages.length, 12);
  assert.deepEqual(pages.slice(0, 4), [1, 2, 3, 4]);
  assert.ok(pages.some((page) => page > 20 && page < 50));
  assert.deepEqual(pages.slice(-2), [59, 60]);
});

test("keeps end coverage when every PDF page contains an important heading", () => {
  const source = Array.from({ length: 30 }, (_, index) => `페이지 ${index + 1}\n신청자격\n${"조건 ".repeat(120)}`).join("\f");
  const selected = selectEvidenceText(source, 12_000);
  assert.ok(selected.selectedPages.includes(1));
  assert.ok(selected.selectedPages.includes(30));
  assert.ok(selected.selectedPages.some((page) => page > 10 && page < 25));
});

test("rejects HTML masquerading as a PDF attachment", () => {
  assert.equal(isPdfBytes(Buffer.from("%PDF-1.7 fixture")), true);
  assert.equal(isPdfBytes(Buffer.from("<html>login</html>")), false);
});

test("only treats OCR as complete when every PDF page succeeded", () => {
  assert.equal(hasCompleteOcrCoverage({ attempted: true, successfulPages: [1] }, 10), false);
  assert.equal(hasCompleteOcrCoverage({ attempted: true, successfulPages: [1, 2] }, 2), true);
  assert.equal(hasCompleteOcrCoverage({ attempted: true, successfulPages: [] }, 0), false);
});
