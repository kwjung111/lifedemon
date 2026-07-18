import { randomUUID } from "node:crypto";
import { chmod, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  assertCompatibleCalendarId, googleCalendarLinesFromEnv, googleCalendarValues,
  mergeGoogleCalendarEnv,
} from "./google-calendar-env.mjs";

const [sourcePath, targetPath] = process.argv.slice(2);
if (!sourcePath || !targetPath) {
  throw new Error("usage: node install-google-calendar-env.mjs SOURCE_GOOGLE_ENV TARGET_SERVICE_ENV");
}

const source = await readFile(sourcePath, "utf8");
const googleLines = googleCalendarLinesFromEnv(source);
const values = googleCalendarValues(source);
const required = [
  "GOOGLE_CALENDAR_ENABLED",
  "GOOGLE_CALENDAR_ID",
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "GOOGLE_OAUTH_REFRESH_TOKEN",
];
const missing = required.filter((key) => !values[key]);
if (missing.length) throw new Error(`Google Calendar environment is missing: ${missing.join(", ")}`);

const target = await readFile(targetPath, "utf8");
assertCompatibleCalendarId(values, target);
const merged = mergeGoogleCalendarEnv(target, googleLines);
const temporaryPath = join(dirname(targetPath), `.google-calendar-env-${randomUUID()}`);
try {
  await writeFile(temporaryPath, merged, { mode: 0o600, flag: "wx" });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, targetPath);
  await chmod(targetPath, 0o600);
} finally {
  await unlink(temporaryPath).catch(() => {});
}
console.log(`INSTALLED_GOOGLE_CALENDAR_ENV=${targetPath}`);
