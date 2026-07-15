import { collectAll } from "./collect.mjs";
import { sendDailyReport } from "./report.mjs";

const summary = await collectAll();
console.log("collection", summary);
await sendDailyReport(summary);
console.log("daily report sent");
