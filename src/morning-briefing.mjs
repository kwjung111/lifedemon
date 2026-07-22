import { runScheduledMorningBriefing } from "./apps/briefing/scheduled.mjs";

const result = await runScheduledMorningBriefing();
console.log(result.snapshot.readiness.ready ? "morning briefing sent" : "incomplete morning briefing sent", result.deliveryKey);
