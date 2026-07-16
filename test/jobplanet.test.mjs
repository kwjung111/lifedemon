import assert from "node:assert/strict";
import test from "node:test";
import { parseJobPlanetCompanyCard } from "../src/apps/jobs/jobplanet.mjs";

test("parses rating and employee count from an authorized JobPlanet company card", () => {
  assert.deepEqual(parseJobPlanetCompanyCard("메가존클라우드(주) 2.8 IT/웹/통신 ∙ 서울 8년차 (2018) 2700명 채용 중 88", "메가존클라우드(주)"), {
    company: "메가존클라우드(주)", jobplanetRating: 2.8, employeeCount: 2700,
    provenance: "jobplanet_authorized_session", verifiedAt: new Date().toISOString().slice(0, 10),
  });
});
