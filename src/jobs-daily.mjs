import { collectJobs } from "./apps/jobs/collect.mjs";
import { filterJobs } from "./apps/jobs/filter.mjs";
import { sendJobReport } from "./apps/jobs/report.mjs";

const collection = await collectJobs();
console.log("job collection", collection);
const filtering = await filterJobs();
console.log("job filtering", filtering);
await sendJobReport(collection);
console.log("job report sent");
