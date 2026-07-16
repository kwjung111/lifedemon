import { filterJobs } from "../apps/jobs/filter.mjs";

console.log(JSON.stringify(await filterJobs(), null, 2));
