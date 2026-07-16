import { kstDateTimeToIso, proposeReminder } from "../apps/reminders/service.mjs";

const presets = {
  "sh-youth-2026-1-document-result": {
    title: "2026년 1차 청년 매입임대주택 서류심사대상자 발표",
    dueAt: kstDateTimeToIso("2026-07-20", "16:00"),
    url: null,
    module: "housing",
    entityKey: "sh-youth-2026-1:document-result",
    resolver: "housing-official",
    metadata: {
      source: "SH",
      eventType: "document-screening-result",
      keywords: ["2026년 1차", "청년", "매입임대주택"],
    },
  },
};

const reminder = presets[process.argv[2]];
if (!reminder) throw new Error("unknown reminder preset");
await proposeReminder(reminder);
console.log("proposed", reminder.entityKey);
