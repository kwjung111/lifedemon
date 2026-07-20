import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const fallbackError = /usage limit|rate limit|quota|insufficient_quota|credits?|authentication|unauthorized|login required/i;
const placeholderKey = /^(?:missing|unset|none|null|replace[_ -]?me|your[_ -]?(?:api[_ -]?)?key)$/i;

export function shouldFallbackToApi(error) {
  return fallbackError.test(`${error?.message || ""}\n${error?.stderr || ""}`);
}

export function apiFallbackKey(env = process.env) {
  const value = String(env.CODEX_API_FALLBACK_KEY || env.OPENAI_API_KEY || "").trim();
  return value && !placeholderKey.test(value) ? value : null;
}

async function findCodexBin(env) {
  const candidates = [
    env.CODEX_BIN,
    join(homedir(), ".local", "bin", process.platform === "win32" ? "codex.exe" : "codex"),
    "codex",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate === "codex") return candidate;
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch { /* try next */ }
  }
  return "codex";
}

function safeCodexEnv(env, apiKey) {
  const kept = [
    "PATH", "Path", "HOME", "USERPROFILE", "CODEX_HOME", "LANG", "LC_ALL", "TZ",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
  ];
  const childEnv = Object.fromEntries(kept.filter((key) => env[key]).map((key) => [key, env[key]]));
  if (apiKey) {
    childEnv.CODEX_API_KEY = apiKey;
    childEnv.OPENAI_API_KEY = apiKey;
    childEnv.CODEX_HOME = env.CODEX_API_HOME || join(homedir(), ".codex-api");
  }
  return childEnv;
}

function spawnCodex(bin, args, { cwd, input, env, timeoutMs, taskName }) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    let forceTimer = null;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      forceTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timer); clearTimeout(forceTimer); reject(error); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      clearTimeout(forceTimer);
      if (code === 0) return resolve({ stdout, stderr });
      const error = new Error(`Codex ${taskName} failed (${signal || code})`);
      error.stderr = stderr.slice(-4000);
      reject(error);
    });
    child.stdin.end(input);
  });
}

const memoryFallbackUsage = new Map();

async function reserveFallback(env, durable = true) {
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  const configuredLimit = Number(env.CODEX_API_DAILY_CALL_LIMIT || 10);
  const limit = Number.isFinite(configuredLimit) ? Math.max(0, Math.min(1000, configuredLimit)) : 0;
  if (!durable) {
    const calls = (memoryFallbackUsage.get(date) || 0) + 1;
    memoryFallbackUsage.set(date, calls);
    return { allowed: calls <= limit, calls, limit, date };
  }
  const { reserveApiFallbackCall } = await import("./state.mjs");
  return reserveApiFallbackCall({ date, limit });
}

async function notifyFallback(env, taskName, usage) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  try {
    const { enqueueTelegramOutbox } = await import("./state.mjs");
    enqueueTelegramOutbox({
      method: "sendMessage",
      payload: {
        chat_id: String(env.TELEGRAM_CHAT_ID),
        text: `⚠️ Codex 계정 한도로 API 과금 모드로 전환했습니다.\n작업: ${taskName}\n오늘 ${usage.calls}/${usage.limit}회`,
        disable_web_page_preview: true,
      },
      dedupeKey: `api-fallback-notice:${usage.date}`,
    });
  } catch { /* fallback work must not fail because an informational notice could not queue */ }
}

export async function runCodexStructuredWithFallback(options) {
  const env = options.env || process.env;
  const runner = options.codexRunner || runCodexStructuredOnce;
  const customRunner = Boolean(options.codexRunner && options.codexRunner !== runCodexStructuredOnce);
  try {
    return await runner({ ...options, codexRunner: undefined, apiKey: null });
  } catch (error) {
    const enabled = String(env.CODEX_API_FALLBACK_ENABLED || "false").toLowerCase() === "true";
    const fallbackKey = apiFallbackKey(env);
    if (!enabled || !fallbackKey || !shouldFallbackToApi(error)) throw error;
    const usage = await reserveFallback(env, !customRunner);
    if (!usage.allowed) throw new Error(`Codex API fallback daily limit reached (${usage.limit})`);
    if (!customRunner) await notifyFallback(env, options.taskName || "structured task", usage);
    return runner({ ...options, codexRunner: undefined, apiKey: fallbackKey });
  }
}

export async function runCodexStructuredOnce({
  prompt,
  schema,
  env = process.env,
  apiKey = null,
  timeoutMs = 60_000,
  search = false,
  taskName = "structured task",
}) {
  const workDir = await mkdtemp(join(tmpdir(), "monitor-codex-"));
  try {
    const schemaPath = join(workDir, "schema.json");
    const outputPath = join(workDir, "result.json");
    await writeFile(schemaPath, JSON.stringify(schema), { mode: 0o600 });
    const bin = await findCodexBin(env);
    const args = [
      ...(search ? ["--search"] : []),
      "exec", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "--cd", workDir,
      "--output-schema", schemaPath, "--output-last-message", outputPath, "-",
    ];
    await spawnCodex(bin, args, {
      cwd: workDir,
      input: prompt,
      env: safeCodexEnv(env, apiKey),
      timeoutMs,
      taskName,
    });
    return JSON.parse(await readFile(outputPath, "utf8"));
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
