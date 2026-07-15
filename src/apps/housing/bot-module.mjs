import {
  getNotice,
  addHousingRule,
  disableHousingRule,
  listHousingRules,
  noticeForDigestItem,
  noticeForMessage,
  saveTelegramMessage,
  setAnnouncementDate,
  setApplication,
} from "../../db.mjs";
import { sendMessage, telegram } from "../../telegram.mjs";
import { sendStatus } from "../../report.mjs";
import { HOUSING_BASE_INSTRUCTION, parseRuleCommand } from "./instructions.mjs";

const appliedWords = /넣었|지원했|신청했|접수했/;
const datePattern = /(20\d{2})[.\/-](\d{1,2})[.\/-](\d{1,2})/;

function normalizedDate(text) {
  const match = text.match(datePattern);
  return match ? `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}` : null;
}

function callbackParts(data) {
  const parts = String(data || "").split(":");
  return parts[0] === "h" ? [parts[1], parts[2]] : [parts[0], parts[1]];
}

export const housingBotModule = {
  id: "housing",
  help: "🏠 주거 공고\n브리핑에 답장: ‘3번 넣었어’, ‘3번 2026-08-10 발표’\n/housing_status : 지원 진행 현황\n/instructions : 기본 지침\n/rules : 추가 지침\n예: ‘민간임대는 앞으로 제외해’",

  canHandleCallback(query) {
    const data = String(query.data || "");
    return data.startsWith("h:") || /^(ap|ig):/.test(data);
  },

  async handleCallback(query) {
    const [action, id] = callbackParts(query.data);
    const notice = getNotice(id);
    if (!notice) {
      await telegram("answerCallbackQuery", { callback_query_id: query.id, text: "공고를 찾지 못했습니다." });
      return;
    }
    if (action === "ap") {
      setApplication(id, "applied");
      await telegram("answerCallbackQuery", { callback_query_id: query.id, text: "지원 상태로 저장했습니다." });
      const confirmation = await sendMessage(`✅ 지원 진행 중으로 저장했습니다.\n[${notice.source}] ${notice.title}\n\n발표일을 알면 이 메시지에 “2026-08-10 발표”처럼 답장해 주세요.`);
      saveTelegramMessage(confirmation.message_id, notice.id);
    } else if (action === "ig") {
      setApplication(id, "ignored");
      await telegram("answerCallbackQuery", { callback_query_id: query.id, text: "관심 없음으로 저장했습니다." });
    }
  },

  async handleMessage(message) {
    const text = String(message.text || "").trim();
    if (/^\/instructions(?:@\w+)?$/i.test(text) || /^기본\s*지침\s*(?:보여줘)?$/i.test(text)) {
      await sendMessage(`🏠 주거 봇 기본 지침\n\n${HOUSING_BASE_INSTRUCTION}`);
      return true;
    }
    if (/^\/rules(?:@\w+)?$/i.test(text) || /^(?:추가\s*)?지침\s*(?:목록|보여줘)$/i.test(text)) {
      const rules = listHousingRules();
      await sendMessage(rules.length
        ? `🏠 적용 중인 추가 지침\n\n${rules.map((rule) => `${rule.id}. ${rule.instruction}`).join("\n")}`
        : "현재 적용 중인 추가 지침이 없습니다.");
      return true;
    }
    const rule = parseRuleCommand(text);
    if (rule?.action === "delete") {
      const deleted = disableHousingRule(rule.id);
      await sendMessage(deleted ? `🗑️ ${rule.id}번 지침을 삭제했습니다.` : `활성 상태인 ${rule.id}번 지침을 찾지 못했습니다.`);
      return true;
    }
    if (rule?.action === "add") {
      const saved = addHousingRule(rule);
      await sendMessage(`⚙️ 지침을 저장했습니다. 다음 수집부터 적용합니다.\n${saved.id}. ${saved.instruction}\n\n/rules : 전체 지침 확인`);
      return true;
    }
    if (/^\/(?:housing_)?status(?:@\w+)?$/i.test(text) || /^(?:진행중|지원현황|뭐 넣었어)\s*$/i.test(text)) {
      await sendStatus();
      return true;
    }

    const replyMessageId = message.reply_to_message?.message_id;
    if (!replyMessageId) return false;
    const itemNumber = Number(text.match(/^\s*(\d{1,2})\s*번?/)?.[1] || 0);
    const replied = (itemNumber ? noticeForDigestItem(replyMessageId, itemNumber) : null)
      || noticeForMessage(replyMessageId);
    if (!replied) return false;

    if (appliedWords.test(text)) {
      setApplication(replied.id, "applied");
      await sendMessage(`✅ 지원 진행 중으로 저장했습니다: ${replied.title}\n발표일을 알면 같은 공고 메시지에 날짜를 답장해 주세요.`);
      return true;
    }
    const date = normalizedDate(text);
    if (date) {
      setAnnouncementDate(replied.id, date);
      await sendMessage(`📅 ${replied.title}\n발표일을 ${date}로 저장했습니다.`);
      return true;
    }
    await sendMessage("주거 브리핑에는 공고 번호를 붙여 답장해 주세요. 예: ‘3번 넣었어’");
    return true;
  },
};
