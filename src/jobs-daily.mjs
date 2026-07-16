import { collectJobs } from "./apps/jobs/collect.mjs";
import { filterJobs } from "./apps/jobs/filter.mjs";
import { sendJobReport } from "./apps/jobs/report.mjs";
import { verifyActiveJobCompanies } from "./apps/jobs/verify-companies.mjs";

const collection = await collectJobs();
console.log("job collection", collection);
const verification = await verifyActiveJobCompanies();
console.log("job company verification", verification);
const filtering = await filterJobs();
console.log("job filtering", filtering);
await sendJobReport(collection);
console.log("job report sent");
