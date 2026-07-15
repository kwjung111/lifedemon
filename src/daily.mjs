import { collectAll } from "./collect.mjs";
import { sendDailyReport } from "./report.mjs";
import { runAgentReviews } from "./apps/housing/agent-review.mjs";

const summary = await collectAll();
console.log("collection", summary);
const reviews = await runAgentReviews({ limit: 3 });
console.log("agent reviews", reviews);
await sendDailyReport(summary, reviews);
console.log("daily report sent");
