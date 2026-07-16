import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const UNCONFIGURED_PROFILE = Object.freeze({
  note: "No verified user profile is configured. Treat personal eligibility as uncertain.",
});

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateValue(value, path = "profile", depth = 0) {
  if (depth > 8) throw new Error(`${path} exceeds the maximum nesting depth`);
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error(`${path} must be finite`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 200) throw new Error(`${path} has too many items`);
    value.forEach((item, index) => validateValue(item, `${path}[${index}]`, depth + 1));
    return;
  }
  if (!isPlainObject(value)) throw new Error(`${path} contains an unsupported value`);
  for (const [key, item] of Object.entries(value)) {
    if (!key.trim() || key.length > 100) throw new Error(`${path} contains an invalid key`);
    validateValue(item, `${path}.${key}`, depth + 1);
  }
}

export function validateHousingProfile(profile) {
  if (!isPlainObject(profile)) throw new Error("housing user profile must be a JSON object");
  validateValue(profile);
  if (JSON.stringify(profile).length > 100_000) throw new Error("housing user profile is too large");
  return profile;
}

export function loadHousingProfile(path = process.env.HOUSING_USER_PROFILE_FILE) {
  if (!path) return UNCONFIGURED_PROFILE;
  return validateHousingProfile(JSON.parse(readFileSync(path, "utf8")));
}

export function requireHousingProfile() {
  if (!process.env.HOUSING_USER_PROFILE_FILE) {
    throw new Error("HOUSING_USER_PROFILE_FILE is required for housing AI reviews");
  }
  return loadHousingProfile();
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function housingProfileFingerprint(profile = loadHousingProfile()) {
  validateHousingProfile(profile);
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(profile)))
    .digest("hex")
    .slice(0, 32);
}
