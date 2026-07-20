import { execFile } from "node:child_process";
import { chmod, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const dataDir = process.env.MONITOR_DATA_DIR || "/data/crawler/data";
const backupRoot = process.env.MONITOR_BACKUP_DIR || "/data/crawler/backups";
const retentionDays = Math.max(3, Math.min(365, Number(process.env.MONITOR_BACKUP_RETENTION_DAYS || 30)));

function kstTimestamp() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}-${value.hour}${value.minute}${value.second}`;
}

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function backupDatabase(name, targetDir) {
  const source = join(dataDir, name);
  const target = join(targetDir, name);
  await execFileAsync("/usr/bin/sqlite3", [source, `VACUUM INTO ${sqlString(target)}`], { timeout: 10 * 60_000 });
  await chmod(target, 0o600);
}

await mkdir(backupRoot, { recursive: true, mode: 0o700 });
await chmod(backupRoot, 0o700);
const targetDir = join(backupRoot, kstTimestamp());
await mkdir(targetDir, { recursive: true, mode: 0o700 });
for (const name of ["platform.sqlite", "housing.sqlite", "jobs.sqlite"]) await backupDatabase(name, targetDir);

const cutoff = Date.now() - retentionDays * 86_400_000;
for (const entry of await readdir(backupRoot, { withFileTypes: true })) {
  const match = entry.name.match(/^(20\d{2}-\d{2}-\d{2})-\d{6}$/);
  if (!entry.isDirectory() || !match) continue;
  if (Date.parse(`${match[1]}T00:00:00+09:00`) < cutoff) {
    await rm(join(backupRoot, entry.name), { recursive: true, force: true });
  }
}
console.log(`Backup completed: ${targetDir}`);
