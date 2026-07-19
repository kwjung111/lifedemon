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
  if (apiKey) childEnv.CODEX_API_KEY = apiKey;
  return childEnv;
}

function spawnCodex(bin, args, { cwd, input, env, timeoutMs, taskName }) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ stdout, stderr });
      const error = new Error(`Codex ${taskName} failed (${signal || code})`);
      error.stderr = stderr.slice(-4000);
      reject(error);
    });
    child.stdin.end(input);
  });
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
