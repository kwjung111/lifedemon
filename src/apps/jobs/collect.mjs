import { collectAllPublicJobSources } from "./collectors.mjs";
import { markJobSourceComplete, upsertJobPosting } from "./db.mjs";
import { jobDiscoveryQueries, loadJobProfile } from "./profile.mjs";

export async function collectJobs(options = {}) {
  const profile = loadJobProfile();
  const sources = await collectAllPublicJobSources({ queries: jobDiscoveryQueries(profile), ...options });
  return sources.map(({ source, jobs, error }) => {
    if (error) return { source, count: 0, error };
    const ids = jobs.map(upsertJobPosting);
    markJobSourceComplete(source, ids);
    return { source, count: ids.length };
  });
}
