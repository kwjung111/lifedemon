import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { sendMessage } from "../telegram.mjs";
import { redactSecrets } from "../core/redact.mjs";

export function sanitizeFailureText(value) {
  return redactSecrets(value, 1800);
}

function command(file, args) {
  const result = spawnSync(file, args, { encoding: "utf8", timeout: 10_000 });
  return sanitizeFailureText(result.stdout || result.stderr || "");
}

export function buildFailureMessage(unit, { status = "", logs = "", hostname = "" } = {}) {
  return [
    "🚨 Life Daemon 서비스 실패",
    `서비스: ${unit || "unknown"}`,
    hostname ? `호스트: ${hostname}` : null,
    `시각: ${new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul", hour12: false })}`,
    status ? `상태: ${sanitizeFailureText(status).replace(/\r?\n/g, " · ")}` : null,
    logs ? `최근 로그:\n${sanitizeFailureText(logs)}` : "최근 로그를 읽지 못했습니다. journalctl로 확인하세요.",
  ].filter(Boolean).join("\n").slice(0, 3900);
}

export async function notifySystemdFailure(unit) {
  const status = command("/usr/bin/systemctl", ["show", unit, "--property=Result,ExecMainCode,ExecMainStatus,StatusText", "--no-pager"]);
  const logs = command("/usr/bin/journalctl", ["--unit", unit, "--lines", "8", "--no-pager", "--output=cat"]);
  const hostname = command("/usr/bin/hostname", []);
  return sendMessage(buildFailureMessage(unit, { status, logs, hostname }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const unit = process.argv[2];
  if (!unit) throw new Error("systemd unit name is required");
  await notifySystemdFailure(unit);
}
