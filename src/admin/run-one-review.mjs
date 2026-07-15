import { runAgentReviews } from "../apps/housing/agent-review.mjs";

console.log(JSON.stringify(await runAgentReviews({ limit: 1 }), null, 2));
