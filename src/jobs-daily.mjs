import { collectJobs } from "./apps/jobs/collect.mjs";
import { drainJobFilters } from "./apps/jobs/filter.mjs";
import { sendJobReport } from "./apps/jobs/report.mjs";
import { verifyActiveJobCompanies } from "./apps/jobs/verify-companies.mjs";
import { companyVerificationFingerprint, loadAuthorizedCompanyVerifications } from "./apps/jobs/company-verification.mjs";
import { jobFilterQueueHealth, setJobSetting } from "./apps/jobs/db.mjs";
import { jobProfileFingerprint, loadJobProfile } from "./apps/jobs/profile.mjs";
import { summarizeJobsDailyRun } from "./apps/jobs/daily-state.mjs";

const kstDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date());
const startedAt = new Date().toISOString();
const saveRun = (status, phase, extra = {}) => setJobSetting("jobs_daily_last_run", JSON.stringify({
  date: kstDate, startedAt, updatedAt: new Date().toISOString(), status, phase, ...extra,
}));

saveRun("running", "collecting");
try {
  const collection = await collectJobs();
  console.log("job collection", collection);
  saveRun("running", "verifying");
  const verification = await verifyActiveJobCompanies();
  console.log("job company verification", verification);
  saveRun("running", "filtering");
  const filtering = await drainJobFilters();
  console.log("job filtering", filtering);
  const queue = jobFilterQueueHealth(
    jobProfileFingerprint(loadJobProfile()),
    companyVerificationFingerprint(loadAuthorizedCompanyVerifications()),
  );
  const finalState = summarizeJobsDailyRun({ collection, verification, filtering, queue });
  saveRun(finalState.status, "finished", { completedAt: new Date().toISOString(), ...finalState });
  if (String(process.env.DAILY_REPORT_ENABLED || "true").toLowerCase() !== "false") {
    await sendJobReport(collection, { filtering, verification, deliveryKey: `jobs-daily:${kstDate}` });
    console.log("job report sent");
  } else console.log("job report deferred to morning briefing");
} catch (error) {
  saveRun("failed", "failed", { completedAt: new Date().toISOString(), errors: [error.message] });
  throw error;
}
