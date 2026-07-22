import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "lifedemon-housing-collection-status-"));
process.env.HOUSING_DATA_DIR = dataDir;
const { classifyHugCollection, classifyYouthSupplyResponse } = await import("../src/collect.mjs");
const { db } = await import("../src/db.mjs");

test.after(() => { db.close(); rmSync(dataDir, { recursive: true, force: true }); });

function youthPayload(rows, overrides = {}) {
  return { resultList: rows, pagingInfo: { totRow: rows.length, totPage: 1, pageIndex: 1, rowCount: 500, ...overrides } };
}

test("treats a complete official Youth list without active supply as empty", () => {
  const result = classifyYouthSupplyResponse(youthPayload([
    { homeCode: "1", homeName: "완료 단지", supplyStatus: "05" },
    { homeCode: "2", homeName: "마감 단지", supplyStatus: "07" },
  ]));
  assert.equal(result.state, "empty");
});

test("rejects incomplete or unknown Youth supply data instead of claiming empty", () => {
  assert.equal(classifyYouthSupplyResponse(youthPayload([
    { homeCode: "1", homeName: "완료 단지", supplyStatus: "05" },
  ], { totRow: 2 })).state, "error");
  assert.equal(classifyYouthSupplyResponse(youthPayload([
    { homeCode: "1", homeName: "미지 단지", supplyStatus: "99" },
  ])).state, "error");
});

test("does not mistake an unmatched active Youth home for an empty list", () => {
  const result = classifyYouthSupplyResponse(youthPayload([
    { homeCode: "1", homeName: "활성 단지", supplyStatus: "02" },
  ]), [{ title: "전혀 다른 모집공고", url: "https://example.test" }]);
  assert.equal(result.state, "error");
});

test("requires every active Youth home to match a distinctive notice", () => {
  const result = classifyYouthSupplyResponse(youthPayload([
    { homeCode: "1", homeName: "성수 센트럴파크", supplyStatus: "02" },
    { homeCode: "2", homeName: "마곡 플라워타워", supplyStatus: "01" },
  ]), [
    { title: "성수 센트럴파크 청년주택 모집공고", url: "https://example.test/1" },
    { title: "마곡 청년주택 모집공고", url: "https://example.test/wrong" },
  ]);
  assert.equal(result.state, "error");
});

test("requires all three official HUG zero-result signals", () => {
  const empty = classifyHugCollection({
    bodyText: "등록된 게시물이 없습니다.", totalText: "총 0건", dataRowCount: 0,
    notices: [{ title: "숨겨진 과거 입주자 모집공고문", url: "old.pdf" }],
  });
  assert.equal(empty.state, "empty");
  assert.equal(classifyHugCollection({ bodyText: "", totalText: "총 0건", dataRowCount: 0, notices: [] }).state, "error");
  assert.equal(classifyHugCollection({ bodyText: "목록", totalText: "총 1건", dataRowCount: 1, notices: [] }).state, "error");
  assert.equal(classifyHugCollection({ bodyText: "목록", totalText: "총 2건", dataRowCount: 1,
    notices: [{ title: "과거 입주자 모집공고문", url: "old.pdf" }] }).state, "error");
});
