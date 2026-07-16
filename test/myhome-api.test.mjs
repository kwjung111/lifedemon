import assert from "node:assert/strict";
import test from "node:test";

import { collectMyHomeApi } from "../src/myhome-api.mjs";

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.MYHOME_API_SERVICE_KEY;
});

test("aggregates every house row under a stable public notice id", async () => {
  process.env.MYHOME_API_SERVICE_KEY = "test-key";
  globalThis.fetch = async () => new Response(JSON.stringify({
    response: {
      header: { resultCode: "00", resultMsg: "NORMAL SERVICE" },
      body: {
        totalCount: "2",
        item: [
          {
            pblancId: "20784", houseSn: "1", pblancNm: "서울 행복주택 모집공고",
            url: "https://apply.lh.or.kr/notice", rcritPblancDe: "20260715",
            beginDe: "20260727", endDe: "20260728", hsmpNm: "H1", sumSuplyCo: "66",
          },
          {
            pblancId: "20784", houseSn: "2", pblancNm: "서울 행복주택 모집공고",
            url: "https://apply.lh.or.kr/notice", rcritPblancDe: "20260715",
            beginDe: "20260727", endDe: "20260728", hsmpNm: "H2", sumSuplyCo: "15",
          },
        ],
      },
    },
  }), { status: 200 });

  const result = await collectMyHomeApi([]);

  assert.equal(result.notices.length, 1);
  assert.equal(result.notices[0].id, "myhome:20784");
  assert.equal(result.notices[0].publishedAt, "2026-07-15");
  assert.equal(result.notices[0].applyStart, "2026-07-27");
  assert.equal(result.notices[0].applyEnd, "2026-07-28");
  assert.deepEqual(JSON.parse(result.notices[0].rawText).map((item) => item.hsmpNm), ["H1", "H2"]);
});

test("rejects a successful-looking response with a missing schema", async () => {
  process.env.MYHOME_API_SERVICE_KEY = "test-key";
  globalThis.fetch = async () => new Response(JSON.stringify({ response: {} }), { status: 200 });

  await assert.rejects(() => collectMyHomeApi([]), /INVALID_RESPONSE/);
});
