import { resolveHousingReminder } from "../apps/housing/reminder-resolver.mjs";

const result = await resolveHousingReminder({
  metadata_json: JSON.stringify({
    source: "SH",
    eventType: "document-screening-result",
    keywords: ["2026년 1차", "청년", "매입임대주택"],
  }),
  url: null,
});
console.log(result);
