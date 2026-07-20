import assert from "node:assert/strict";
import test from "node:test";

import { semanticPreferences, semanticPreferenceScore } from "../src/apps/feedback/preferences.mjs";

const event = (id, signal, keyword) => ({
  id, domain: "jobs", entity_id: `job-${id}`, signal,
  metadata_json: JSON.stringify({
    interpretation: {
      scope: "job_role", strength: "medium", keywords: [keyword],
      aspects: [{ scope: "job_role", sentiment: signal, keyword }],
    },
  }),
});

test("latest feedback supersedes an older contradictory preference", () => {
  const preferences = semanticPreferences([
    event(1, "positive", "DevOps"),
    event(2, "negative", "데브옵스"),
  ], "jobs");
  assert.equal(preferences.length, 1);
  assert.equal(preferences[0].sentiment, "negative");
  assert.equal(semanticPreferenceScore({ id: "new", title: "DevOps Engineer" }, preferences, "jobs"), -2);
});

test("an empty normalized company keyword never matches every company", () => {
  const score = semanticPreferenceScore({ company: "안전한회사", title: "SRE" }, [{
    entityId: "old", scope: "company", sentiment: "negative", keyword: ".", strength: "high",
  }], "jobs");
  assert.equal(score, 0);
});

test("maps common Korean and English role concepts", () => {
  const score = semanticPreferenceScore({ title: "클라우드 데브옵스 엔지니어" }, [{
    entityId: "old", scope: "job_role", sentiment: "positive", keyword: "DevOps", strength: "medium",
  }], "jobs");
  assert.equal(score, 2);
});
