import { sendMessage } from "../../telegram.mjs";

export const BASIC_MANUAL = `📖 Life Daemon 사용법

그냥 보내세요
일정·할 일·메모·링크·사진·문서를 보내면 Inbox에 저장합니다.

정시 알림은 “알려줘”를 붙이세요
예: 내일 오후 4시에 서류 발표 알려줘

나중에 고치려면 /inbox
목록 말풍선에 답장해 “2번 완료”, “1번을 23일로 바꿔”, “2번 보여줘”처럼 보내세요.

공고도 평소 말투로 요청하세요
예: 채용공고 싹 보여줘 · 주택 추천 이어서 보여줘
안 보이는 공고는 “큐픽스 공고 왜 안 보여?”처럼 물으면 저장된 이유를 확인합니다.

평일 오전 9시에는 오늘 행동·주택·채용 핵심만 한 번 보냅니다.
/ask는 서버 상태나 Codex 사용량 질문에만 필요합니다.

전체 명령은 /help 자세히`;

export const DETAILED_MANUAL = `🔎 전체 기능

오늘: /briefing
저장 항목: /inbox
예정 알림: /remind · /reminders · /calendar_status
주거: /housing_status · /housing_guide · /housing_rules
채용: /jobs · /job_status
취향: /feedback
시스템: /daemon · /ask 질문

새 알림은 명령 없이 “…알려줘”라고 보내도 됩니다.
저장·수정·피드백에는 /ask가 필요하지 않습니다.`;

export function createManualBotModule({ send = sendMessage } = {}) {
  return {
    id: "manual",
    commands: [{ command: "help", description: "📖 처음이라면 여기" }],
    async handleMessage(message) {
      const text = String(message.text || "").trim();
      if (/^\/(?:start|help|manual)(?:@\w+)?\s*(?:자세히|전체|detail)?\s*$/i.test(text)) {
        await send(/(?:자세히|전체|detail)\s*$/i.test(text) ? DETAILED_MANUAL : BASIC_MANUAL);
        return true;
      }
      return false;
    },
  };
}

export const manualBotModule = createManualBotModule();
