import { collectWantedWebSearch } from "../apps/jobs/wanted-web-search.mjs";

const maxResults = Math.min(50, Math.max(1, Number(process.argv[2]) || 10));
const jobs = await collectWantedWebSearch({
  queries: ["DevOps", "SRE", "Platform Engineer", "Cloud Engineer", "인프라 엔지니어"],
  maxResults,
});

console.log(JSON.stringify({
  count: jobs.length,
  jobs: jobs.map(({ company, title, url, location, experience }) => ({ company, title, url, location, experience })),
}, null, 2));
