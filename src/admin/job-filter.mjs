import { drainJobFilters } from "../apps/jobs/filter.mjs";

console.log(JSON.stringify(await drainJobFilters(), null, 2));
