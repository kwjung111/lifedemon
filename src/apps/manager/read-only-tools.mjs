import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import { createConnection } from "node:net";
import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { promisify } from "node:util";
import { db } from "../../db.mjs";
import { jobDb } from "../jobs/db.mjs";
import { platformDb } from "../../core/state.mjs";
import { redactSecrets } from "../../core/redact.mjs";

const execFileAsync = promisify(execFile);
const repoPath = "/data/crawler";

export const diagnosticUnits = [
  "monitor-telegram-bot.service",
  "monitor-reminder.service",
  "housing-daily.service",
  "housing-daily.timer",
  "housing-result-check.service",
  "housing-result-check.timer",
  "jobs-daily.service",
  "jobs-daily.timer",
];

export const diagnosticToolNames = [
  "service_status",
  "service_logs",
  "unit_definition",
  "recent_errors",
  "database_health",
  "system_resources",
  "deployment_status",
  "environment_health",
  "network_status",
  "code_search",
];

const allowedUnits = new Set(diagnosticUnits);
const allowedDomains = new Set(["housing", "jobs", "platform"]);
const networkHosts = [
  "api.telegram.org",
  "apis.data.go.kr",
  "www.i-sh.co.kr",
  "www.wanted.co.kr",
  "www.googleapis.com",
  "api.openai.com",
];
const searchableExtensions = new Set([".mjs", ".service", ".timer", ".json"]);

async function defaultCommand(file, args, options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      encoding: "utf8",
      timeout: options.timeout || 10_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      cwd: options.cwd,
    });
    return redactSecrets(stdout || stderr || "(no output)");
  } catch (error) {
    return redactSecrets([
      `command failed: ${error.message}`,
      error.stdout,
      error.stderr,
    ].filter(Boolean).join("\n"));
  }
}

function assertUnit(unit) {
  if (!allowedUnits.has(unit)) throw new Error("unit is outside the diagnostic allowlist");
  return unit;
}

function intWithin(value, fallback, min, max) {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function grouped(database, table, column) {
  return database.prepare(`SELECT ${column} AS name, COUNT(*) AS count FROM ${table} GROUP BY ${column} ORDER BY ${column}`).all();
}

function quickCheck(database) {
  const row = database.prepare("PRAGMA quick_check").get();
  return Object.values(row || {})[0] || "unknown";
}

function databaseHealth(domain) {
  if (!allowedDomains.has(domain)) throw new Error("database domain is outside the diagnostic allowlist");
  if (domain === "housing") {
    return {
      quickCheck: quickCheck(db),
      activeNotices: db.prepare("SELECT COUNT(*) AS count FROM notices WHERE active=1").get().count,
      reviewQueue: grouped(db, "review_queue", "state"),
      applications: grouped(db, "applications", "status"),
      resultChecks: grouped(db, "application_result_checks", "state"),
      telemetry: db.prepare("SELECT key, value FROM settings WHERE key IN ('housing_collection_last_attempt_at','housing_collection_last_success_at') ORDER BY key").all(),
    };
  }
  if (domain === "jobs") {
    return {
      quickCheck: quickCheck(jobDb),
      activePostings: jobDb.prepare("SELECT COUNT(*) AS count FROM job_postings WHERE active=1").get().count,
      filterQueue: grouped(jobDb, "job_filter_queue", "state"),
      applications: grouped(jobDb, "job_applications", "status"),
      assessmentCount: jobDb.prepare("SELECT COUNT(*) AS count FROM job_assessments").get().count,
      recentFilterErrors: jobDb.prepare("SELECT last_error, updated_at FROM job_filter_queue WHERE state='error' ORDER BY updated_at DESC LIMIT 5").all(),
      telemetry: jobDb.prepare("SELECT key, value FROM job_settings WHERE key IN ('job_collection_last_attempt_at','job_collection_last_success_at') ORDER BY key").all(),
    };
  }
  return {
    quickCheck: quickCheck(platformDb),
    reminders: grouped(platformDb, "reminders", "status"),
    calendarErrors: platformDb.prepare("SELECT title, calendar_sync_error, updated_at FROM reminders WHERE calendar_sync_error IS NOT NULL ORDER BY updated_at DESC LIMIT 5").all(),
  };
}

function environmentHealth(env = process.env) {
  const present = (name) => Boolean(String(env[name] || "").trim());
  return {
    telegram: present("TELEGRAM_BOT_TOKEN") && present("TELEGRAM_CHAT_ID"),
    myhomeApi: present("MYHOME_API_SERVICE_KEY"),
    housingProfile: present("HOUSING_USER_PROFILE_FILE"),
    jobProfile: present("JOB_USER_PROFILE_FILE"),
    companyVerification: present("JOB_COMPANY_VERIFICATION_FILE"),
    codexBinary: present("CODEX_BIN"),
    apiFallback: present("CODEX_API_FALLBACK_KEY") || present("OPENAI_API_KEY"),
    googleCalendarEnabled: String(env.GOOGLE_CALENDAR_ENABLED || "").toLowerCase() === "true",
    googleCalendarCredentials: [
      "GOOGLE_CALENDAR_ID", "GOOGLE_OAUTH_CLIENT_ID",
      "GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_OAUTH_REFRESH_TOKEN",
    ].every(present),
  };
}

function tcpCheck(host, timeout = 3000) {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port: 443 });
    const finish = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeout, () => finish({ tcp443: false, error: "timeout" }));
    socket.once("connect", () => finish({ tcp443: true }));
    socket.once("error", (error) => finish({ tcp443: false, error: error.code || error.message }));
  });
}

async function networkStatus({ dnsLookup = lookup, connect = tcpCheck } = {}) {
  return Promise.all(networkHosts.map(async (host) => {
    try {
      const dns = await dnsLookup(host);
      return { host, dns: true, addressFamily: dns.family, ...await connect(host) };
    } catch (error) {
      return { host, dns: false, tcp443: false, error: error.code || error.message };
    }
  }));
}

export async function searchRepositorySource(query, root = repoPath) {
  const terms = String(query || "").toLowerCase().split(/\s+/).filter((term) => term.length >= 2);
  if (!terms.length) throw new Error("code search query has no usable terms");
  const files = [join(root, "package.json")];
  const pending = [join(root, "src"), join(root, "systemd")];
  while (pending.length && files.length < 500) {
    const directory = pending.pop();
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && searchableExtensions.has(extname(entry.name))) files.push(path);
    }
  }
  const matches = [];
  for (const file of files) {
    const text = await readFile(file, "utf8");
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const candidate = lines[index].toLowerCase();
      if (!terms.every((term) => candidate.includes(term))) continue;
      const start = Math.max(0, index - 2);
      const end = Math.min(lines.length, index + 3);
      matches.push(`${relative(root, file)}:${index + 1}\n${lines.slice(start, end).map((line, offset) => `${start + offset + 1}: ${line}`).join("\n")}`);
      if (matches.length >= 80) return matches.join("\n\n");
    }
  }
  return matches.length ? matches.join("\n\n") : "No source matches found.";
}

function normalizeCall(call) {
  const tool = diagnosticToolNames.includes(call?.tool) ? call.tool : null;
  if (!tool) throw new Error("tool is outside the diagnostic allowlist");
  return {
    tool,
    unit: call.unit || null,
    domain: call.domain || null,
    lines: intWithin(call.lines, 80, 10, 200),
    sinceMinutes: intWithin(call.since_minutes, 1440, 5, 10080),
    query: String(call.query || "").replace(/[\r\n\0]/g, " ").trim().slice(0, 120),
  };
}

export async function executeReadOnlyTool(call, {
  command = defaultCommand,
  env = process.env,
  dnsLookup = lookup,
  connect = tcpCheck,
  search = searchRepositorySource,
} = {}) {
  const normalized = normalizeCall(call);
  let output;
  switch (normalized.tool) {
    case "service_status": {
      const unit = assertUnit(normalized.unit);
      output = await command("/usr/bin/systemctl", [
        "show", unit,
        "--property=Id,Description,LoadState,ActiveState,SubState,Result,ExecMainCode,ExecMainStatus,StatusText,NRestarts,ActiveEnterTimestamp,InactiveEnterTimestamp,NextElapseUSecRealtime,LastTriggerUSec",
        "--no-pager",
      ]);
      break;
    }
    case "service_logs": {
      const unit = assertUnit(normalized.unit);
      output = await command("/usr/bin/journalctl", [
        "--unit", unit,
        "--since", `${normalized.sinceMinutes} minutes ago`,
        "--lines", String(normalized.lines),
        "--no-pager", "--output=short-iso",
      ]);
      break;
    }
    case "unit_definition": {
      const unit = assertUnit(normalized.unit);
      output = await command("/usr/bin/systemctl", ["cat", unit, "--no-pager"]);
      break;
    }
    case "recent_errors": {
      const serviceUnits = diagnosticUnits.filter((unit) => unit.endsWith(".service"));
      output = (await Promise.all(serviceUnits.map(async (unit) => ({
        unit,
        logs: await command("/usr/bin/journalctl", [
          "--unit", unit,
          "--since", `${normalized.sinceMinutes} minutes ago`,
          "--priority", "emerg..warning",
          "--lines", "40", "--no-pager", "--output=short-iso",
        ]),
      }))));
      break;
    }
    case "database_health":
      output = databaseHealth(normalized.domain);
      break;
    case "system_resources":
      output = {
        disk: await command("/usr/bin/df", ["-h", repoPath]),
        memory: await command("/usr/bin/free", ["-m"]),
        uptime: await command("/usr/bin/uptime", []),
      };
      break;
    case "deployment_status":
      output = {
        status: await command("/usr/bin/git", ["-C", repoPath, "status", "--short", "--branch"]),
        revision: await command("/usr/bin/git", ["-C", repoPath, "log", "-5", "--format=%h %cI %s %d"]),
      };
      break;
    case "environment_health":
      output = environmentHealth(env);
      break;
    case "network_status":
      output = await networkStatus({ dnsLookup, connect });
      break;
    case "code_search":
      if (normalized.query.length < 2) throw new Error("code search query is too short");
      output = await search(normalized.query);
      break;
    default:
      throw new Error("unsupported diagnostic tool");
  }
  return {
    tool: normalized.tool,
    args: {
      unit: normalized.unit,
      domain: normalized.domain,
      lines: normalized.lines,
      sinceMinutes: normalized.sinceMinutes,
      query: normalized.query || null,
    },
    output: typeof output === "string" ? redactSecrets(output) : redactSecrets(JSON.stringify(output)),
  };
}
