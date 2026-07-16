import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const requiredArrays = ["preferredRoles", "excludedRoles"];

export function loadJobProfile(path = process.env.JOB_USER_PROFILE_FILE) {
  if (!path) throw new Error("JOB_USER_PROFILE_FILE is required; job conditions must stay outside Git");
  const profile = JSON.parse(readFileSync(path, "utf8"));
  if (!profile || Array.isArray(profile) || typeof profile !== "object") throw new Error("job profile must be a JSON object");
  for (const key of requiredArrays) {
    if (!Array.isArray(profile.preferences?.[key]) || !profile.preferences[key].every((value) => typeof value === "string" && value.trim())) {
      throw new Error(`job profile preferences.${key} must be a non-empty string array`);
    }
  }
  const rating = Number(profile.companyFilters?.jobplanet?.minimumRating);
  if (!Number.isFinite(rating) || rating < 0 || rating > 5) throw new Error("job profile must define a Jobplanet rating from 0 to 5");
  if (profile.companyFilters?.jobplanet?.excludeWhenMissing !== true) throw new Error("job profile must explicitly choose strict Jobplanet verification");
  const employeeCount = Number(profile.companyFilters?.minimumEmployeeCount);
  if (!Number.isInteger(employeeCount) || employeeCount < 1) throw new Error("job profile must define a positive minimum employee count");
  return profile;
}

export function jobDiscoveryQueries(profile) {
  const configured = profile.preferences?.discoveryQueries;
  const values = Array.isArray(configured) && configured.length ? configured : profile.preferences.preferredRoles;
  return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))].slice(0, 12);
}

export function jobProfileFingerprint(profile) {
  const canonicalize = (value) => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
    }
    return value;
  };
  return createHash("sha256").update(JSON.stringify(canonicalize(profile))).digest("hex").slice(0, 24);
}
