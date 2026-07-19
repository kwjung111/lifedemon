import assert from "node:assert/strict";
import test from "node:test";
import { wantedSessionStatus } from "../src/apps/jobs/wanted-session.mjs";

test("recognizes signed-in and expired Wanted browser surfaces", () => {
  assert.equal(wantedSessionStatus({ url: "https://social.wanted.co.kr/my/profile", hasMyWanted: true }), "signed_in");
  assert.equal(wantedSessionStatus({ url: "https://www.wanted.co.kr/login" }), "signed_out");
  assert.equal(wantedSessionStatus({ url: "https://www.wanted.co.kr/", hasLoginButton: true }), "signed_out");
  assert.equal(wantedSessionStatus({ url: "https://www.wanted.co.kr/search" }), "unknown");
});
