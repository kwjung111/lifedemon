import assert from "node:assert/strict";
import test from "node:test";
import { buildWantedSearchPrompt, collectWantedWebSearch, normalizeWantedSearchResult, shouldFallbackToApi } from "../src/apps/jobs/wanted-web-search.mjs";
import { wantedPostingUrls } from "../src/integrations/gmail.mjs";

test("keeps only active canonical Wanted DevOps postings", () => {
  const jobs = normalizeWantedSearchResult({ jobs: [
    { company: "A", title: "Platform Engineer", url: "https://www.wanted.co.kr/wd/123?referer=x", location: "서울", experience: "3년", rawText: "Kubernetes Terraform", active: true },
    { company: "A", title: "duplicate", url: "https://wanted.co.kr/wd/123", location: null, experience: null, rawText: "DevOps", active: true },
    { company: "B", title: "Backend", url: "https://www.wanted.co.kr/wd/456", location: null, experience: null, rawText: "Java", active: true },
    { company: "C", title: "SRE", url: "https://evil.example/wd/789", location: null, experience: null, rawText: "SRE", active: true },
    { company: "D", title: "DevOps", url: "https://www.wanted.co.kr/wd/999", location: null, experience: null, rawText: "closed", active: false },
  ] });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].url, "https://www.wanted.co.kr/wd/123");
  assert.equal(jobs[0].externalId, "123");
});

test("builds a constrained live-search prompt with Gmail candidates", () => {
  const prompt = buildWantedSearchPrompt({ queries: ["SRE", "DevOps"], candidateUrls: ["https://www.wanted.co.kr/wd/7"], maxResults: 20, now: new Date("2026-07-19T00:00:00Z") });
  assert.match(prompt, /wanted\.co\.kr\/wd\/<numeric-id>/);
  assert.match(prompt, /2026-07-19/);
  assert.match(prompt, /DevSecOps/);
  assert.match(prompt, /https:\/\/www\.wanted\.co\.kr\/wd\/7/);
  assert.match(prompt, /untrusted data/);
});

test("extracts and canonicalizes Wanted posting URLs from MIME bodies", () => {
  const text = 'open https://www.wanted.co.kr/wd/123?utm=x and https%3A%2F%2Fwanted.co.kr%2Fwd%2F456';
  const message = { payload: { parts: [{ body: { data: Buffer.from(text).toString("base64url") } }] } };
  assert.deepEqual(wantedPostingUrls(message), ["https://www.wanted.co.kr/wd/123", "https://www.wanted.co.kr/wd/456"]);
});

test("uses API fallback only for quota or authentication failures", () => {
  assert.equal(shouldFallbackToApi(Object.assign(new Error("usage limit reached"), { stderr: "" })), true);
  assert.equal(shouldFallbackToApi(Object.assign(new Error("temporary DNS error"), { stderr: "" })), false);
});

test("retries a quota failure with the configured API fallback key", async () => {
  const attempts = [];
  const jobs = await collectWantedWebSearch({
    queries: ["DevOps"],
    env: { CODEX_API_FALLBACK_KEY: "fallback" },
    gmailCandidates: async () => ({ urls: [], error: null }),
    codexRunner: async ({ apiKey }) => {
      attempts.push(apiKey);
      if (!apiKey) throw new Error("quota exceeded");
      return { jobs: [{ company: "A", title: "DevOps", url: "https://www.wanted.co.kr/wd/1", location: null, experience: null, rawText: "AWS Kubernetes", active: true }] };
    },
  });
  assert.deepEqual(attempts, [null, "fallback"]);
  assert.equal(jobs.length, 1);
});
