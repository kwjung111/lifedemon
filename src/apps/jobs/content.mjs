import { createHash } from "node:crypto";

const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();

function beforeFirst(value, markers) {
  let end = value.length;
  for (const marker of markers) {
    const index = value.search(marker);
    if (index >= 0) end = Math.min(end, index);
  }
  return value.slice(0, end);
}

function fromFirst(value, markers) {
  for (const marker of markers) {
    const index = value.search(marker);
    if (index >= 0) return value.slice(index);
  }
  return value;
}

function normalizeVolatileCounters(value) {
  return value
    .replace(/\bD\s*-\s*\d+\b/gi, "D-N")
    .replace(/\d[\d,]*\s*명\s*이상\s*찜/gi, "찜 수")
    .replace(/\d[\d,]*\s*명\s*찜/gi, "찜 수")
    .replace(/조회\s*\d[\d,]*/gi, "조회 수");
}

function absoluteDateTokens(value) {
  const tokens = String(value || "").match(/(?:20\d{2})[.\/-]\s*(?:0?[1-9]|1[0-2])[.\/-]\s*(?:0?[1-9]|[12]\d|3[01])/g) || [];
  return [...new Set(tokens.map((token) => token.replace(/\s+/g, "").replace(/[./]/g, "-")))].sort();
}

function canonicalWantedLocation(value) {
  const text = clean(value);
  const regions = [
    [/서울(?:특별시|시)?/, "서울"], [/경기(?:도)?/, "경기"], [/인천(?:광역시|시)?/, "인천"],
    [/부산(?:광역시|시)?/, "부산"], [/대구(?:광역시|시)?/, "대구"], [/대전(?:광역시|시)?/, "대전"],
    [/광주(?:광역시|시)?/, "광주"], [/울산(?:광역시|시)?/, "울산"], [/세종(?:특별자치시|시)?/, "세종"],
    [/강원(?:특별자치도|도)?/, "강원"], [/충청북도|충북/, "충북"], [/충청남도|충남/, "충남"],
    [/전북특별자치도|전라북도|전북/, "전북"], [/전라남도|전남/, "전남"],
    [/경상북도|경북/, "경북"], [/경상남도|경남/, "경남"], [/제주특별자치도|제주도|제주/, "제주"],
  ];
  for (const [pattern, region] of regions) {
    const match = text.match(pattern);
    if (!match) continue;
    const rest = clean(text.replace(match[0], " ")).replace(/^[,./\-\s]+/, "");
    const metro = ["서울", "인천", "부산", "대구", "대전", "광주", "울산"].includes(region);
    const district = metro
      ? rest.match(/^([가-힣]{1,8}(?:구|군))(?=\s|$)/)
      : rest.match(/^([가-힣]{1,8}(?:시|군))(?=\s|$)(?:\s+([가-힣]{1,8}구)(?=\s|$))?/);
    return [region, ...(district ? district.slice(1).filter(Boolean) : [])].join("/");
  }
  return "";
}

function canonicalWantedExperience(value) {
  const text = clean(value);
  if (!text) return "";
  if (/경력\s*무관|무관/.test(text)) return "무관";
  const types = [/[신新]입/.test(text) ? "신입" : null, /경력/.test(text) ? "경력" : null].filter(Boolean);
  const years = [...new Set([...text.matchAll(/(\d+)\s*년/g)].map((match) => `${Number(match[1])}년`))];
  return [...types, ...years].join("/");
}

export function stableJobAssessmentText(source, rawText) {
  const name = String(source || "").toLowerCase();
  const original = clean(rawText);
  if (!original) return "";

  // Wanted is currently collected through a live-search summary. Its wording is
  // non-deterministic, so only stable absolute dates may influence change detection.
  if (name === "wanted") return absoluteDateTokens(original).join(" ");

  let text = original;
  if (name === "remember") {
    text = beforeFirst(text, [
      /이 공고와 비슷한 공고도 함께 살펴보세요/i,
      /비슷한 공고를 확인해보세요/i,
      /다른 공고 더 보기/i,
    ]);
    text = fromFirst(text, [/공고소개/i, /주요업무/i, /자격요건/i]);
    text = text.replace(/이 포지션 한눈에 보기\s*by\s*AI.*?(?=주요업무|자격요건|우대사항|채용절차|기타안내)/gi, " ");
  } else if (name === "jobkorea") {
    text = beforeFirst(text, [
      /로그인하고 비슷한 조건의 AI추천공고/i,
      /이 공고와 함께 본 공고/i,
      /추천공고 더보기/i,
      /지원자\s*현황/i,
      /관련\s*태그/i,
      /본\s*채용정보는/i,
      /TOP\s*궁금해요/i,
    ]);
    text = fromFirst(text, [/모집요강/i, /지원자격/i, /담당업무/i]);
    text = text.replace(/\d[\d,]*\s*명\s*이상\s*찜/gi, "찜 수");
  }
  return clean(normalizeVolatileCounters(text));
}

export function jobAssessmentText(source, rawText) {
  return String(source || "").toLowerCase() === "wanted"
    ? clean(rawText)
    : stableJobAssessmentText(source, rawText);
}

export function jobContentHash(job) {
  const wanted = String(job.source || "").toLowerCase() === "wanted";
  const value = {
    company: clean(job.company),
    title: clean(job.title),
    url: String(job.url || ""),
    // Remember/JobKorea derive these fields from the first matching line in the
    // whole page, so related-card hydration can make them point at another job.
    // Their stable JD section already carries real location/seniority changes.
    location: wanted ? canonicalWantedLocation(job.location) : "",
    experience: wanted ? canonicalWantedExperience(job.experience) : "",
    text: stableJobAssessmentText(job.source, job.rawText ?? job.raw_text),
  };
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
}
