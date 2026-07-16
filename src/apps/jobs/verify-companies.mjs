import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { activeJobCompanies } from "./db.mjs";
import { lookupJobPlanetCompany, mergeCompanyVerifications } from "./jobplanet.mjs";

export async function verifyActiveJobCompanies({ limit = 100 } = {}) {
  const file = process.env.JOB_COMPANY_VERIFICATION_FILE;
  if (!file) throw new Error("JOB_COMPANY_VERIFICATION_FILE is required for JobPlanet verification output");
  mkdirSync(dirname(file), { recursive: true });
  const results = [];
  for (const company of activeJobCompanies(limit)) {
    try { results.push({ company, verification: await lookupJobPlanetCompany(company) }); }
    catch (error) { results.push({ company, error: error.message }); }
  }
  const saved = mergeCompanyVerifications(file, results.map((result) => result.verification));
  return { saved, results };
}
