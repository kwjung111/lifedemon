import { randomUUID } from "node:crypto";
import { chmod, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { gmailLinesFromEnv, gmailValues, mergeGmailEnv } from "./gmail-env.mjs";

const [sourcePath, targetPath] = process.argv.slice(2);
if (!sourcePath || !targetPath) throw new Error("usage: node install-gmail-env.mjs SOURCE_GMAIL_ENV TARGET_SERVICE_ENV");
const source = await readFile(sourcePath, "utf8");
const lines = gmailLinesFromEnv(source);
const values = gmailValues(source);
const missing = ["GMAIL_WANTED_ENABLED", "GMAIL_WANTED_QUERY", "GMAIL_OAUTH_REFRESH_TOKEN"].filter((key) => !values[key]);
if (missing.length) throw new Error(`Gmail environment is missing: ${missing.join(", ")}`);
const target = await readFile(targetPath, "utf8");
const temporaryPath = join(dirname(targetPath), `.gmail-env-${randomUUID()}`);
try {
  await writeFile(temporaryPath, mergeGmailEnv(target, lines), { mode: 0o600, flag: "wx" });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, targetPath);
  await chmod(targetPath, 0o600);
} finally {
  await unlink(temporaryPath).catch(() => {});
}
console.log(`INSTALLED_GMAIL_ENV=${targetPath}`);
