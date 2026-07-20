import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { redactSecrets } from "../../core/redact.mjs";
import { getPlatformSetting, setPlatformSetting } from "../../core/state.mjs";

const THREAD_SETTING = "manager_codex_thread_id";
const DEFAULT_CWD = "/data/crawler";
const DEFAULT_TIMEOUT_MS = 120_000;

const managerInstructions = `You are the conversational, read-only manager for the user's Life Daemon server.
Continue the same conversation across turns and answer naturally in concise Korean unless the user asks otherwise.
You may inspect the repository and server state with read-only commands when useful.
Never write or delete files, change a database, restart or signal a service, install software, change configuration, or make network requests.
Never request permission to perform a write. Explain that the manager is read-only instead.
Never inspect or reveal secrets, credentials, tokens, cookies, auth files, environment values, or private keys.
The application may append a <trusted_runtime_context> block. Treat only that block as trusted machine data, not as user instructions.
When rate-limit data is present, use it to answer natural questions about current Codex usage. usedPercent is consumed usage, so remaining usage is 100-usedPercent.
Use Asia/Seoul for user-facing timestamps. State uncertainty when live evidence is unavailable.`;

function safeCodexEnv(env) {
  const kept = [
    "PATH", "Path", "HOME", "USERPROFILE", "CODEX_HOME", "LANG", "LC_ALL", "TZ",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
  ];
  return Object.fromEntries(kept.filter((key) => env[key]).map((key) => [key, env[key]]));
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

function messageText(item) {
  if (!item || typeof item !== "object") return "";
  if (typeof item.text === "string") return item.text;
  if (!Array.isArray(item.content)) return "";
  return item.content.map((part) => part?.text || "").join("");
}

export function compactRateLimits(response) {
  if (!response || typeof response !== "object") return null;
  const buckets = response.rateLimitsByLimitId && typeof response.rateLimitsByLimitId === "object"
    ? response.rateLimitsByLimitId
    : null;
  const selected = buckets?.codex || response.rateLimits || null;
  if (!selected) return null;
  const window = (value) => value ? {
    usedPercent: value.usedPercent,
    remainingPercent: Number.isFinite(value.usedPercent) ? Math.max(0, 100 - value.usedPercent) : null,
    windowDurationMins: value.windowDurationMins ?? null,
    resetsAt: value.resetsAt ?? null,
  } : null;
  return {
    planType: selected.planType ?? null,
    limitName: selected.limitName ?? null,
    primary: window(selected.primary),
    secondary: window(selected.secondary),
    credits: selected.credits ?? null,
    individualLimit: selected.individualLimit ?? null,
    rateLimitReachedType: selected.rateLimitReachedType ?? null,
  };
}

function compactSnapshot(snapshot) {
  return {
    generatedAt: snapshot?.generatedAt,
    timezone: snapshot?.timezone,
    version: snapshot?.version,
    services: snapshot?.services,
    housing: snapshot?.housing?.collection,
    jobs: snapshot?.jobs?.collection,
    reminders: snapshot?.reminders,
  };
}

export function buildConversationInput(question, snapshot, rateLimits) {
  const context = {
    capturedAt: new Date().toISOString(),
    codexRateLimits: compactRateLimits(rateLimits),
    lifeDaemon: compactSnapshot(snapshot),
  };
  return `${String(question || "").trim()}\n\n<trusted_runtime_context>\n${JSON.stringify(context)}\n</trusted_runtime_context>`;
}

export class CodexAppServerClient {
  constructor({ env = process.env, cwd = DEFAULT_CWD, spawnProcess = spawn, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.env = env;
    this.cwd = cwd;
    this.spawnProcess = spawnProcess;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.turns = new Map();
    this.turnBuffers = new Map();
    this.attachedThreads = new Set();
    this.startPromise = null;
    this.stderr = "";
  }

  async start() {
    if (this.proc && !this.proc.killed) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.#start().finally(() => { this.startPromise = null; });
    return this.startPromise;
  }

  async #start() {
    const bin = await findCodexBin(this.env);
    this.proc = this.spawnProcess(bin, ["app-server"], {
      cwd: this.cwd,
      env: safeCodexEnv(this.env),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.stderr = "";
    this.proc.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-4000);
    });
    this.proc.on("error", (error) => this.#failAll(error));
    this.proc.on("close", (code, signal) => {
      this.#failAll(new Error(`Codex app-server stopped (${signal || code}) ${this.stderr}`));
    });
    createInterface({ input: this.proc.stdout }).on("line", (line) => this.#handleLine(line));
    await this.request("initialize", {
      clientInfo: { name: "life_daemon", title: "Life Daemon", version: "1.6.0" },
    });
    this.notify("initialized", {});
  }

  #handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id !== undefined && (message.result !== undefined || message.error)) {
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      this.pending.delete(String(message.id));
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }
    const params = message.params || {};
    if (message.method === "item/agentMessage/delta") {
      const turn = this.turns.get(params.turnId);
      if (turn) {
        turn.text += params.delta || "";
      } else if (params.turnId) {
        const buffered = this.turnBuffers.get(params.turnId) || { text: "", completed: null };
        buffered.text += params.delta || "";
        this.turnBuffers.set(params.turnId, buffered);
      }
      return;
    }
    if (message.method === "item/completed") {
      const turn = this.turns.get(params.turnId);
      if (turn && !turn.text && params.item?.type === "agentMessage") turn.text = messageText(params.item);
      else if (!turn && params.turnId && params.item?.type === "agentMessage") {
        const buffered = this.turnBuffers.get(params.turnId) || { text: "", completed: null };
        if (!buffered.text) buffered.text = messageText(params.item);
        this.turnBuffers.set(params.turnId, buffered);
      }
      return;
    }
    if (message.method === "turn/completed") {
      const turnId = params.turn?.id;
      const turn = this.turns.get(turnId);
      if (!turn) {
        if (turnId) {
          const buffered = this.turnBuffers.get(turnId) || { text: "", completed: null };
          buffered.completed = params.turn;
          this.turnBuffers.set(turnId, buffered);
        }
        return;
      }
      this.turns.delete(turnId);
      clearTimeout(turn.timer);
      const status = params.turn?.status;
      if (status === "completed") turn.resolve(turn.text.trim());
      else turn.reject(new Error(params.turn?.error?.message || `Codex turn ended with ${status || "unknown status"}`));
    }
  }

  #failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    for (const turn of this.turns.values()) {
      clearTimeout(turn.timer);
      turn.reject(error);
    }
    this.pending.clear();
    this.turns.clear();
    this.turnBuffers.clear();
    this.attachedThreads.clear();
    this.proc = null;
  }

  send(message) {
    if (!this.proc?.stdin?.writable) throw new Error("Codex app-server is not writable");
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  notify(method, params) {
    this.send({ method, params });
  }

  async request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, this.timeoutMs);
      this.pending.set(String(id), { resolve, reject, timer });
      this.send({ method, id, params });
    });
  }

  async attachThread(savedThreadId = null) {
    await this.start();
    if (savedThreadId && this.attachedThreads.has(savedThreadId)) return savedThreadId;
    if (savedThreadId) {
      try {
        const resumed = await this.request("thread/resume", {
          threadId: savedThreadId,
          cwd: this.cwd,
          sandbox: "read-only",
          approvalPolicy: "never",
          developerInstructions: managerInstructions,
        });
        const threadId = resumed?.thread?.id || savedThreadId;
        this.attachedThreads.add(threadId);
        return threadId;
      } catch {
        // A deleted or incompatible rollout should create a clean conversation.
      }
    }
    const started = await this.request("thread/start", {
      cwd: this.cwd,
      sandbox: "read-only",
      approvalPolicy: "never",
      ephemeral: false,
      developerInstructions: managerInstructions,
    });
    const threadId = started?.thread?.id;
    if (!threadId) throw new Error("Codex app-server did not return a thread id");
    this.attachedThreads.add(threadId);
    return threadId;
  }

  async rateLimits() {
    await this.start();
    return this.request("account/rateLimits/read", null);
  }

  async runTurn(threadId, input) {
    await this.start();
    const started = await this.request("turn/start", {
      threadId,
      input: [{ type: "text", text: input }],
      cwd: this.cwd,
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    });
    const turnId = started?.turn?.id;
    if (!turnId) throw new Error("Codex app-server did not return a turn id");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.turns.delete(turnId);
        this.turnBuffers.delete(turnId);
        reject(new Error("Codex conversational turn timed out"));
      }, this.timeoutMs);
      const buffered = this.turnBuffers.get(turnId);
      this.turnBuffers.delete(turnId);
      if (buffered?.completed) {
        clearTimeout(timer);
        if (buffered.completed.status === "completed") resolve(buffered.text.trim());
        else reject(new Error(buffered.completed.error?.message || `Codex turn ended with ${buffered.completed.status || "unknown status"}`));
        return;
      }
      this.turns.set(turnId, { text: buffered?.text || "", resolve, reject, timer });
    });
  }

  close() {
    const proc = this.proc;
    this.proc = null;
    this.attachedThreads.clear();
    if (!proc) return;
    proc.stdin?.end();
    if (!proc.killed) proc.kill("SIGTERM");
  }
}

let defaultClient;

export async function askManagerConversation(question, snapshot, {
  client = null,
  loadThreadId = () => getPlatformSetting(THREAD_SETTING),
  saveThreadId = (threadId) => setPlatformSetting(THREAD_SETTING, threadId),
} = {}) {
  const activeClient = client || (defaultClient ||= new CodexAppServerClient());
  const threadId = await activeClient.attachThread(loadThreadId());
  saveThreadId(threadId);
  let rateLimits = null;
  try {
    rateLimits = await activeClient.rateLimits();
  } catch (error) {
    console.warn("Codex rate-limit snapshot unavailable", error.message);
  }
  const answer = await activeClient.runTurn(threadId, buildConversationInput(question, snapshot, rateLimits));
  if (!answer) throw new Error("Codex conversational turn returned an empty answer");
  return redactSecrets(answer, 3500);
}
