import { sendJobReport } from "./report.mjs";

export const jobsBotModule = {
  id: "jobs",
  help: "💼 채용 공고\n/jobs : 현재 채용 공고와 AI 판정 보기",
  commands: [{ command: "jobs", description: "채용 공고 현황과 AI 판정 보기" }],
  async handleMessage(message) {
    const text = String(message.text || "").trim();
    if (!/^\/jobs(?:@\w+)?$/i.test(text)) return false;
    await sendJobReport();
    return true;
  },
};
