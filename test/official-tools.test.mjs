import assert from "node:assert/strict";
import test from "node:test";

import { officialSearchSource } from "../src/apps/housing/official-tools.mjs";

test("maps MyHome API notices back to the supplying institution", () => {
  assert.equal(officialSearchSource("마이홈 API", JSON.stringify({ suplyInsttNm: "LH" })), "LH");
  assert.equal(officialSearchSource("마이홈 API", JSON.stringify([{ suplyInsttNm: "SH서울주택도시공사" }])), "SH");
  assert.equal(officialSearchSource("마이홈 API", "invalid"), "마이홈");
  assert.equal(officialSearchSource("HUG", ""), "HUG");
});
