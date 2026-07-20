const clean = (value) => String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
const compact = (value) => clean(value).replace(/주식회사|\(주\)|㈜/g, "").replace(/[^0-9a-z가-힣]/g, "");
const conceptRules = [
  [/devops|데브옵스/i, "devops"], [/\bsre\b|사이트신뢰성/i, "sre"],
  [/platform|플랫폼/i, "platform"], [/cloud|클라우드/i, "cloud"],
  [/backend|백엔드/i, "backend"], [/frontend|프론트엔드/i, "frontend"],
  [/매입임대/, "매입임대"], [/전세임대/, "전세임대"], [/청년안심주택/, "청년안심주택"],
  [/월세/, "월세"], [/보증금/, "보증금"], [/관리비/, "관리비"],
];
const stopWords = new Set(["좋다", "좋음", "좋은", "별로", "싫음", "아쉬움", "저렴한", "비싼", "공고", "주택", "회사", "직무"]);

function concept(value) {
  const text = clean(value);
  return conceptRules.find(([pattern]) => pattern.test(text))?.[1] || null;
}

function hasConcept(value, expected) {
  const text = clean(value);
  return conceptRules.some(([pattern, label]) => label === expected && pattern.test(text));
}

function preferenceKey(item) {
  const keyword = item.scope === "company" ? compact(item.keyword) : concept(item.keyword) || compact(item.keyword);
  if (!keyword) return null;
  return `${item.scope}:${item.scope === "item" ? `${item.entityId}:` : ""}${keyword}`;
}

function metadata(event) {
  try { return JSON.parse(event.metadata_json || "{}"); } catch { return {}; }
}

export function semanticPreferences(events, domain) {
  const projected = [];
  const seen = new Set();
  const ordered = [...events].filter((event) => event.domain === domain).sort((a, b) => Number(b.id) - Number(a.id));
  for (const event of ordered) {
    const interpretation = metadata(event).interpretation;
    if (!interpretation || !["positive", "negative", "mixed"].includes(event.signal)) continue;
    const aspects = interpretation.aspects?.length
      ? interpretation.aspects
      : [{
        scope: interpretation.scope || event.subject_type || "item",
        sentiment: event.signal === "mixed" ? null : event.signal,
        keyword: interpretation.keywords?.[0] || event.subject_value,
      }];
    const entries = aspects.filter((aspect) => ["positive", "negative"].includes(aspect.sentiment)).map((aspect) => ({
      entityId: event.entity_id,
      scope: aspect.scope || "item",
      sentiment: aspect.sentiment,
      keyword: String(aspect.keyword || "").trim(),
      strength: interpretation.strength || "medium",
    })).filter((item) => item.keyword);
    for (const item of entries) {
      const key = preferenceKey(item);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      projected.push({ ...item, key });
    }
  }
  return projected;
}

function haystack(item, domain, scope) {
  if (scope === "company") return compact(item.company);
  if (scope === "job_role") return clean(`${item.title || ""} ${item.raw_text || ""}`);
  if (scope === "location") return clean(`${item.location || ""} ${item.title || ""} ${item.raw_text || ""}`);
  if (["housing_type", "cost", "eligibility"].includes(scope)) {
    return clean(`${item.title || ""} ${item.raw_text || ""} ${item.ai_result_json || ""}`);
  }
  return clean(`${item.company || ""} ${item.title || ""} ${item.location || ""} ${item.raw_text || ""} ${item.ai_result_json || ""}`);
}

export function semanticPreferenceScore(item, preferences, domain) {
  const weights = { low: 1, medium: 2, high: 3 };
  return preferences.reduce((score, preference) => {
    let matches = preference.scope === "item" ? preference.entityId === item.id : false;
    if (preference.scope === "company") {
      const company = compact(item.company);
      const keyword = compact(preference.keyword);
      matches = Boolean(company && keyword && company === keyword);
    } else if (preference.scope !== "item") {
      const text = haystack(item, domain, preference.scope);
      const knownConcept = concept(preference.keyword);
      if (knownConcept) matches = text.includes(knownConcept) || hasConcept(text, knownConcept);
      else {
        const tokens = clean(preference.keyword).split(/[^0-9a-z가-힣]+/)
          .map((token) => compact(token)).filter((token) => token.length >= 2 && !stopWords.has(token));
        matches = tokens.length > 0 && tokens.filter((token) => text.includes(token)).length >= Math.ceil(tokens.length / 2);
      }
    }
    if (!matches) return score;
    const direction = preference.sentiment === "positive" ? 1 : -1;
    return score + direction * (weights[preference.strength] || 2);
  }, 0);
}
