import { setSetting } from "./db.mjs";
import { chatId, sendMessage, telegram } from "./telegram.mjs";

const updates = await telegram("getUpdates", {
  offset: -1,
  timeout: 0,
  allowed_updates: ["message", "callback_query"],
});
const nextOffset = updates.length ? updates.at(-1).update_id + 1 : 0;
setSetting("telegram_offset", nextOffset);

await telegram("setMyCommands", {
  scope: { type: "chat", chat_id: chatId },
  commands: [
    { command: "status", description: "지원 진행 중인 공고 보기" },
    { command: "help", description: "봇 사용법 보기" },
  ],
});

await sendMessage("🤖 주거공고 상호작용 봇이 연결됐습니다.\n공고 메시지에 답장해 ‘넣었어’라고 말하거나 버튼을 사용하세요.\n/status 로 지원 진행 현황을 볼 수 있습니다.");
console.log(`telegram offset initialized to ${nextOffset}`);
