import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    env: { CODEX_API_FALLBACK_KEY: "fallback", CODEX_API_FALLBACK_ENABLED: "true" },
    gmailCandidates: async () => ({ urls: [], error: null }),
    codexRunner: async ({ apiKey }) => {
      attempts.push(apiKey);
      if (!apiKey) throw new Error("quota exceeded");
      return { jobs: [{ company: "A", title: "DevOps", url: "https://www.wanted.co.kr/wd/1", location: null, experience: null, rawText: "AWS Kubernetes", active: true }] };
    },
    officialFetch: async () => ({ ok: true, json: async () => ({ job: { id: 1, status: "active", due_time: null } }) }),
  });
  assert.deepEqual(attempts, [null, "fallback"]);
  assert.equal(jobs.length, 1);
});

test("rejects a search result when the official Wanted API says the posting is closed", async () => {
  const requested = [];
  const jobs = await collectWantedWebSearch({
    queries: ["DevOps"],
    gmailCandidates: async () => ({ urls: [], error: null }),
    codexRunner: async () => ({ jobs: [
      { company: "닫힌회사", title: "SRE", url: "https://www.wanted.co.kr/wd/10", location: "서울", experience: "5년", rawText: "SRE Kubernetes", active: true },
      { company: "열린회사", title: "DevOps", url: "https://www.wanted.co.kr/wd/20", location: "서울", experience: "3년", rawText: "DevOps AWS", active: true },
      { company: "기한지난회사", title: "Cloud Engineer", url: "https://www.wanted.co.kr/wd/30", location: "서울", experience: "3년", rawText: "Cloud Kubernetes", active: true },
    ] }),
    officialFetch: async (url) => {
      requested.push(url);
      const id = url.match(/\/(\d+)$/)?.[1];
      return {
        ok: true,
        json: async () => ({ job: {
          id: Number(id), status: id === "10" ? "close" : "active",
          due_time: id === "10" ? null : id === "30" ? "2026-07-22" : "2026-12-31",
        } }),
      };
    },
    now: new Date("2026-07-23T00:00:00+09:00"),
  });
  assert.deepEqual(requested, [
    "https://www.wanted.co.kr/api/v4/jobs/10",
    "https://www.wanted.co.kr/api/v4/jobs/20",
    "https://www.wanted.co.kr/api/v4/jobs/30",
  ]);
  assert.deepEqual(jobs.map((job) => job.externalId), ["20"]);
  assert.deepEqual(jobs.inactiveExternalIds, ["10", "30"]);
});

test("deactivates an officially closed Wanted id even when no active result remains", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "lifedemon-wanted-close-"));
  const previous = process.env.JOB_DATA_DIR;
  process.env.JOB_DATA_DIR = dataDir;
  const { jobDb, markJobSourceComplete, upsertJobPosting } = await import(`../src/apps/jobs/db.mjs?closed=${Date.now()}`);
  try {
    const id = upsertJobPosting({
      source: "wanted", externalId: "10", company: "닫힌회사", title: "SRE",
      url: "https://www.wanted.co.kr/wd/10", rawText: "SRE Kubernetes",
    });
    assert.equal(markJobSourceComplete("wanted", [], ["10"]), 1);
    assert.equal(jobDb.prepare("SELECT active FROM job_postings WHERE id=?").get(id).active, 0);
  } finally {
    jobDb.close();
    if (previous === undefined) delete process.env.JOB_DATA_DIR;
    else process.env.JOB_DATA_DIR = previous;
    rmSync(dataDir, { recursive: true, force: true });
  }
});
