import { runAgentReviews } from "../apps/housing/agent-review.mjs";

const results = await runAgentReviews({ maxDurationMs: 40 * 60_000 });
process.stdout.write(`HOUSING_REVIEW_RESULTS=${JSON.stringify(results)}\n`);
