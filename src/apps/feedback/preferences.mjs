const clean = (value) => String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
const compact = (value) => clean(value).replace(/주식회사|\(주\)|㈜/g, "").replace(/[^0-9a-z가-힣]/g, "");

function metadata(event) {
  try { return JSON.parse(event.metadata_json || "{}"); } catch { return {}; }
}

export function semanticPreferences(events, domain) {
  return events.filter((event) => event.domain === domain).flatMap((event) => {
    const interpretation = metadata(event).interpretation;
    if (!interpretation || !["positive", "negative", "mixed"].includes(event.signal)) return [];
    const aspects = interpretation.aspects?.length
      ? interpretation.aspects
      : [{
        scope: interpretation.scope || event.subject_type || "item",
        sentiment: event.signal === "mixed" ? null : event.signal,
        keyword: interpretation.keywords?.[0] || event.subject_value,
      }];
    return aspects.filter((aspect) => ["positive", "negative"].includes(aspect.sentiment)).map((aspect) => ({
      entityId: event.entity_id,
      scope: aspect.scope || "item",
      sentiment: aspect.sentiment,
      keyword: String(aspect.keyword || "").trim(),
      strength: interpretation.strength || "medium",
    })).filter((item) => item.keyword);
  });
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
    const matches = preference.scope === "item"
      ? preference.entityId === item.id
      : haystack(item, domain, preference.scope).includes(
        preference.scope === "company" ? compact(preference.keyword) : clean(preference.keyword),
      );
    if (!matches) return score;
    const direction = preference.sentiment === "positive" ? 1 : -1;
    return score + direction * (weights[preference.strength] || 2);
  }, 0);
}
