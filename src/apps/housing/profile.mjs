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

function profileSecrets(profile) {
  const secrets = new Set();
  const genericStrings = new Set([
    "male", "female", "unmarried", "married", "unknown", "no_filter",
    "true", "false", "yes", "no", "currently_employed",
  ]);
  const visit = (value) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (isPlainObject(value)) return Object.values(value).forEach(visit);
    if (typeof value === "number" && Number.isFinite(value) && Math.abs(value) >= 1000) {
      const raw = String(value);
      secrets.add(raw);
      secrets.add(new Intl.NumberFormat("ko-KR").format(value));
      if (Number.isInteger(value / 10_000)) {
        const manwon = value / 10_000;
        secrets.add(`${new Intl.NumberFormat("ko-KR").format(manwon)}만원`);
        if (Number.isInteger(manwon / 1_000)) secrets.add(`${manwon / 1_000}천만원`);
      }
      if (Number.isInteger(value / 100_000_000)) secrets.add(`${value / 100_000_000}억원`);
      return;
    }
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (trimmed.length >= 2 && !genericStrings.has(trimmed) && !trimmed.startsWith("no_filter")) secrets.add(trimmed);
    const date = trimmed.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
    if (date) {
      const [, year, month, day] = date;
      secrets.add(`${year}년 ${Number(month)}월 ${Number(day)}일`);
      secrets.add(`${year}.${month.padStart(2, "0")}.${day.padStart(2, "0")}`);
      secrets.add(`${year}/${month.padStart(2, "0")}/${day.padStart(2, "0")}`);
    }
    for (const match of trimmed.matchAll(/\d{4,}/g)) {
      secrets.add(match[0]);
      secrets.add(new Intl.NumberFormat("ko-KR").format(Number(match[0])));
    }
  };
  visit(profile);
  return [...secrets].filter(Boolean).sort((a, b) => b.length - a.length);
}

export function redactHousingProfileValues(value, profile = loadHousingProfile()) {
  const secrets = profileSecrets(validateHousingProfile(profile));
  const privateSubject = /사용자|신청자|본인|프로필|생년|생일|출생|일생|나이|연령|청년|연봉|급여|소득|자산|주식|예금|적금|부채/;
  const transformedPrivateValue = /\d|만\s*\d{1,3}\s*세|\d{1,2}월\s*\d{1,2}일생|[일이삼사오육칠팔구십백천만억]+만?원/;
  const redact = (item, key = "") => {
    if (typeof item === "string") {
      const text = secrets.reduce((current, secret) => current.replaceAll(secret, "[개인정보]"), item);
      if (key === "evidence" && /사용자|신청자|본인|프로필/.test(text)) return "[개인정보 관련 판정 제외]";
      if ((key === "income_assets" || privateSubject.test(text))
          && transformedPrivateValue.test(text)) {
        return "[개인정보 관련 판정은 원문 값을 숨김]";
      }
      return text;
    }
    if (Array.isArray(item)) return item.map((child) => redact(child, key));
    if (isPlainObject(item)) return Object.fromEntries(Object.entries(item).map(([childKey, child]) => [childKey, redact(child, childKey)]));
    return item;
  };
  return redact(value);
}

export function containsHousingProfileValues(value, profile = loadHousingProfile()) {
  return JSON.stringify(redactHousingProfileValues(value, profile)) !== JSON.stringify(value);
}
