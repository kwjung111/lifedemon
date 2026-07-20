const number = (value) => value == null ? null : Number(value);

export function parseHousingResultFeedback(text) {
  const value = String(text || "").replace(/\r/g, "").trim();
  const outcome = /미선정|탈락|불합격/.test(value) ? "not_selected"
    : /예비|대기/.test(value) ? "waitlisted"
      : /선정|합격/.test(value) ? "selected" : null;
  const housingName = value.match(/(?:지원\s*주택|신청\s*주택|주택명)\s*[:：]\s*([^\n]+)/)?.[1]?.trim() || null;
  const cutoff = value.match(/(?:컷라인|커트라인)\s*[:：]?\s*(\d+)\s*순위(?:\s*[,·]?\s*(\d+)\s*점)?/);
  const supplyUnits = value.match(/(\d+)\s*호\s*(?:공급)?/)?.[1];
  const reachedPriority = value.match(/([123])\s*순위까지\s*(?:내려|도달|선정|당첨)/)?.[1];
  const preference = value.match(/다음\s*추천\s*기준\s*[:：]\s*([^\n]+)/)?.[1]?.trim() || null;
  return {
    outcome,
    housingName,
    cutoffPriority: number(cutoff?.[1]),
    cutoffScore: number(cutoff?.[2]),
    supplyUnits: number(supplyUnits),
    reachedPriority: number(reachedPriority),
    preference,
    note: value || null,
  };
}
