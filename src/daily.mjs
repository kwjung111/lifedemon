import { spawn } from "node:child_process";
import { collectAll } from "./collect.mjs";
import { sendDailyReport } from "./report.mjs";
import { pendingReviewNotices, recoverStaleReviewClaims } from "./db.mjs";

function runReviewWorker(timeoutMs = 45 * 60_000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["src/admin/run-pending-reviews.mjs"], {
      cwd: process.cwd(), env: process.env, detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-1_000_000); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-20_000); });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform === "win32") child.kill("SIGTERM");
        else process.kill(-child.pid, "SIGTERM");
      } catch { /* worker may already have exited */ }
      setTimeout(() => {
        try {
          if (process.platform === "win32") child.kill("SIGKILL");
          else process.kill(-child.pid, "SIGKILL");
        } catch { /* worker may already have exited */ }
      }, 5_000).unref();
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve([{ error: `review worker failed: ${error.message}` }]);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const marker = stdout.match(/HOUSING_REVIEW_RESULTS=(\[[\s\S]*\])\s*$/);
      if (!timedOut && code === 0 && marker) {
        try { resolve(JSON.parse(marker[1])); return; } catch { /* report worker output below */ }
      }
      recoverStaleReviewClaims(0);
      const deferred = pendingReviewNotices(10_000).length;
      resolve([{
        error: timedOut ? "review worker reached its 45-minute deadline" : `review worker exited ${code}: ${stderr.slice(-500)}`,
        deferred: true, count: deferred,
      }]);
    });
  });
}

const summary = await collectAll();
console.log("collection", summary);
const reviews = await runReviewWorker();
console.log("agent reviews", reviews);
await sendDailyReport(summary, reviews);
console.log("daily report sent");
