import assert from "node:assert/strict";
import test from "node:test";
import { resolveFeedbackTarget } from "../src/apps/feedback/reference.mjs";

const items = [
  { index: 1, id: "one", company: "(주)콘텐츠브릿지", title: "클라우드 운영 엔지니어" },
  { index: 2, id: "two", company: "(주)위시켓", title: "Azure Solutions Architect" },
  { index: 3, id: "three", company: "유니코써치", title: "대기업 계열사 클라우드 운영" },
];

test("resolves natural numeric, ordinal, and company references", () => {
  assert.equal(resolveFeedbackTarget("이 중 2번이 제일 나아", items).item.id, "two");
  assert.equal(resolveFeedbackTarget("두 번째가 제일 나아", items).item.id, "two");
  assert.equal(resolveFeedbackTarget("위시켓은 좀 별로", items).item.id, "two");
  assert.equal(resolveFeedbackTarget("콘텐츠브릿지는 지원해볼 만함", items).item.id, "one");
});

test("infers an unnamed target only for a single-item message", () => {
  assert.equal(resolveFeedbackTarget("이건 별로", [items[0]]).item.id, "one");
  assert.equal(resolveFeedbackTarget("이건 별로", items).item, null);
  assert.equal(resolveFeedbackTarget("9번 괜찮네", items).reason, "invalid_number");
});
