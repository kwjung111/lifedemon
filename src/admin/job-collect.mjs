import { collectJobs } from "../apps/jobs/collect.mjs";

console.log(JSON.stringify(await collectJobs(), null, 2));
