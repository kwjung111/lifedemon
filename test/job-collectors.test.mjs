import assert from "node:assert/strict";
import test from "node:test";
import { inferCompany, inferJobMetadata, linksForSource, publicJobSources } from "../src/apps/jobs/collectors.mjs";

test("keeps only public detail URLs for each source", () => {
  const wanted = publicJobSources.find((source) => source.name === "wanted");
  const links = linksForSource(wanted, [
    { href: "https://www.wanted.co.kr/wd/123", text: "DevOps" },
    { href: "https://www.wanted.co.kr/wd/123", text: "duplicate" },
    { href: "https://www.wanted.co.kr/login", text: "로그인" },
  ]);
  assert.deepEqual(links, [{ href: "https://www.wanted.co.kr/wd/123", text: "DevOps" }]);
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

test("extracts short location and experience lines without using the whole job description", () => {
  const metadata = inferJobMetadata("상세요강\n근무지 서울 강남구\n지원자격\n경력 5년 이상\n긴 설명 ".repeat(200));
  assert.equal(metadata.location, "근무지 서울 강남구");
  assert.equal(metadata.experience, "경력 5년 이상");
});
