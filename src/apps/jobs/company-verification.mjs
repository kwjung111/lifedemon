import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
export const normalizeCompanyName = (value) => clean(value).toLowerCase().replace(/\([^)]*\)|㈜|\(주\)|주식회사/g, "").replace(/\s+/g, "");

// Load the private verification cache refreshed by the signed-in JobPlanet collector.
export function loadAuthorizedCompanyVerifications(path = process.env.JOB_COMPANY_VERIFICATION_FILE) {
  if (!path) return new Map();
  const rows = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(rows)) throw new Error("company verification file must be a JSON array");
  const result = new Map();
  for (const row of rows) {
    const company = normalizeCompanyName(row.company);
    const rating = Number(row.jobplanetRating);
    const employeeCount = Number(row.employeeCount);
    if (!company || !Number.isFinite(rating) || !Number.isInteger(employeeCount) || employeeCount < 0) continue;
    result.set(company, {
      company, jobplanetRating: rating, employeeCount,
      provenance: clean(row.provenance) || "authorized_import", verifiedAt: clean(row.verifiedAt) || null,
    });
  }
  return result;
}

export function companyGate(company, profile, verifications) {
  const key = normalizeCompanyName(company);
  const record = verifications.get(key);
  if (!record) return { decision: "exclude", code: "company_verification_missing", reason: "잡플래닛 평점 또는 직원 수 검증 데이터가 없음" };
  if (record.jobplanetRating < profile.companyFilters.jobplanet.minimumRating) {
    return { decision: "exclude", code: "jobplanet_rating_below_minimum", reason: `잡플래닛 평점 ${record.jobplanetRating}점` };
  }
  if (record.employeeCount < profile.companyFilters.minimumEmployeeCount) {
    return { decision: "exclude", code: "employee_count_below_minimum", reason: `직원 수 ${record.employeeCount}명` };
  }
  return { decision: "continue", code: "company_verified", verification: record };
}

export function companyVerificationFingerprint(verifications) {
  const canonical = [...verifications.values()]
    // A refresh timestamp is audit metadata, not a filtering input. Including it
    // would requeue every active posting once a day even when the rating and size
    // stayed exactly the same.
    .map(({ company, jobplanetRating, employeeCount, provenance }) => ({ company, jobplanetRating, employeeCount, provenance }))
    .sort((a, b) => a.company.localeCompare(b.company));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 24);
}
