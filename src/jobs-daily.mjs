import { collectJobs } from "./apps/jobs/collect.mjs";
import { drainJobFilters } from "./apps/jobs/filter.mjs";
import { sendJobReport } from "./apps/jobs/report.mjs";
import { verifyActiveJobCompanies } from "./apps/jobs/verify-companies.mjs";

const collection = await collectJobs();
console.log("job collection", collection);
const verification = await verifyActiveJobCompanies();
console.log("job company verification", verification);
const filtering = await drainJobFilters();
console.log("job filtering", filtering);
const kstDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date());
if (String(process.env.DAILY_REPORT_ENABLED || "true").toLowerCase() !== "false") {
  await sendJobReport(collection, { filtering, verification, deliveryKey: `jobs-daily:${kstDate}` });
  console.log("job report sent");
} else console.log("job report deferred to morning briefing");
