import assert from "node:assert/strict";
import test from "node:test";
import { inferCompany, inferJobMetadata, inferJobTitle, linksForSource, mapWithConcurrency, normalizePublicJob, publicJobSources } from "../src/apps/jobs/collectors.mjs";

test("limits detail work while preserving each result position", async () => {
  let active = 0;
  let peak = 0;
  const result = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
    active += 1; peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return value * 2;
  });
  assert.equal(peak, 2);
  assert.deepEqual(result, [2, 4, 6, 8, 10]);
});

test("keeps only public detail URLs for each source", () => {
  const wanted = publicJobSources.find((source) => source.name === "wanted");
  const links = linksForSource(wanted, [
    { href: "https://www.wanted.co.kr/wd/123", text: "DevOps" },
    { href: "https://www.wanted.co.kr/wd/123", text: "duplicate" },
    { href: "https://www.wanted.co.kr/login", text: "로그인" },
  ]);
  assert.deepEqual(links, [{ href: "https://www.wanted.co.kr/wd/123", text: "DevOps" }]);
});

test("uses query-specific public pages and routes Wanted through Codex web search", () => {
  const wanted = publicJobSources.find((source) => source.name === "wanted");
  const jobkorea = publicJobSources.find((source) => source.name === "jobkorea");
  assert.equal(wanted.collector, "codex-web-search");
  assert.equal(jobkorea.listUrl("SRE 엔지니어"), "https://www.jobkorea.co.kr/Search/?stext=SRE%20%EC%97%94%EC%A7%80%EB%8B%88%EC%96%B4");
});

test("canonicalizes JobKorea detail URLs and keeps the posting id", () => {
  const jobkorea = publicJobSources.find((source) => source.name === "jobkorea");
  const job = normalizePublicJob(jobkorea, {
    title: "DevOps 엔지니어", company: "좋은회사",
    url: "https://www.jobkorea.co.kr/Recruit/GI_Read/49220858?Oem_Code=C1&stext=DevOps",
    rawText: "공고 본문",
  });
  assert.equal(job.url, "https://www.jobkorea.co.kr/Recruit/GI_Read/49220858");
  assert.equal(job.externalId, "49220858");
});

test("canonicalizes Remember detail URLs across discovery queries", () => {
  const remember = publicJobSources.find((source) => source.name === "remember");
  const job = normalizePublicJob(remember, {
    title: "DevOps 엔지니어", company: "좋은회사",
    url: "https://career.rememberapp.co.kr/job/posting/324818?postQuerySessionId=abc&isHighlight=true",
    rawText: "공고 본문",
  });
  assert.equal(job.url, "https://career.rememberapp.co.kr/job/posting/324818");
  assert.equal(job.externalId, "324818");
});

test("keeps only matching listing cards when a discovery query is supplied", () => {
  const wanted = publicJobSources.find((source) => source.name === "wanted");
  const links = linksForSource(wanted, [
    { href: "https://www.wanted.co.kr/wd/1", text: "DevOps Engineer" },
    { href: "https://www.wanted.co.kr/wd/2", text: "Backend Engineer" },
  ], "DevOps");
  assert.deepEqual(links, [{ href: "https://www.wanted.co.kr/wd/1", text: "DevOps Engineer" }]);
});

test("derives companies only from source title formats", () => {
  assert.equal(inferCompany("remember", "좋은회사 채용 | 데브옵스 엔지니어"), "좋은회사");
  assert.equal(inferCompany("wanted", "좋은회사 - DevOps Engineer | 원티드"), "좋은회사");
  assert.equal(inferCompany("jobkorea", "좋은회사 채용 - DevOps Engineer | 잡코리아"), "좋은회사");
});

test("removes JobKorea company and site chrome from fallback titles", () => {
  assert.equal(
    inferJobTitle("jobkorea", "좋은회사 채용 - DevOps 엔지니어 | 잡코리아"),
    "DevOps 엔지니어",
  );
  assert.equal(inferJobTitle("jobkorea", "무시", "직접 표시된 제목"), "직접 표시된 제목");
});

test("extracts short location and experience lines without using the whole job description", () => {
  const metadata = inferJobMetadata("상세요강\n근무지 서울 강남구\n지원자격\n경력 5년 이상\n긴 설명 ".repeat(200));
  assert.equal(metadata.location, "근무지 서울 강남구");
  assert.equal(metadata.experience, "경력 5년 이상");
});
