import { sendMorningBriefing } from "./apps/briefing/report.mjs";

const date = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date());

await sendMorningBriefing({ deliveryKey: `morning-briefing:${date}` });
console.log("morning briefing sent");
