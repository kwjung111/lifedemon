import { collectAllPublicJobSources } from "./collectors.mjs";
import { markJobSourceComplete, setJobSetting, upsertJobPostingWithStatus } from "./db.mjs";
import { jobDiscoveryQueries, loadJobProfile } from "./profile.mjs";

export async function collectJobs(options = {}) {
  const profile = loadJobProfile();
  const sources = await collectAllPublicJobSources({ queries: jobDiscoveryQueries(profile), ...options });
  const summary = sources.map(({ source, jobs, error }) => {
    if (error) return { source, count: 0, error };
    const changes = jobs.map(upsertJobPostingWithStatus);
    const deactivatedCount = markJobSourceComplete(source, changes.map(({ id }) => id));
    return {
      source, count: changes.length,
      newCount: changes.filter(({ change }) => change === "new").length,
      changedCount: changes.filter(({ change }) => change === "changed").length,
      deactivatedCount,
    };
  });
  const completedAt = new Date().toISOString();
  setJobSetting("job_collection_last_attempt_at", completedAt);
  if (summary.every((entry) => !entry.error)) setJobSetting("job_collection_last_success_at", completedAt);
  return summary;
}
