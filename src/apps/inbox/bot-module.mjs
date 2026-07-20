import { recordFeedbackEvent, telegramMessageContext } from "../../core/state.mjs";
import { sendMessage } from "../../telegram.mjs";
import { classifyInboxMessage } from "./classifier.mjs";
import { interpretInboxReply } from "./correction.mjs";
import {
  createInboxItem, getInboxItem, latestInboxItem, listInboxItems, updateInboxItem,
} from "./store.mjs";

const kindLabels = {
  event: "일정으로", task: "할 일로", watch: "확인할 것으로", note: "메모로", reference: "참고자료로",
};

function kstDateTime(value) {
  if (!value) return null;
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul", year: "numeric", month: "numeric", day: "numeric",
    weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(value));
}

function itemMessage(item, lead = "저장했어요") {
  const lines = [`✅ ${kindLabels[item.kind] || "항목으로"} ${lead}.`, item.title];
  if (item.event_at) lines.push(`시점: ${kstDateTime(item.event_at)}`);
  lines.push(`다음 행동: ${item.next_action}`);
  if (item.source_url) lines.push(item.source_url);
  if (item.assumptions?.length) lines.push(`가정: ${item.assumptions.slice(0, 2).join(" · ")}`);
  lines.push("바꾸거나 취소하려면 이 메시지에 평소 말투로 답장해 주세요.");
  return lines.join("\n");
}

function listMessage(items) {
  if (!items.length) return "📥 저장된 생활 항목이 없어요.";
  const lines = [`📥 지금 챙길 것 ${items.length}개`];
  for (const [index, item] of items.entries()) {
    const at = item.event_at ? ` · ${kstDateTime(item.event_at)}` : "";
    lines.push(`${index + 1}. ${item.title}${at}\n   다음: ${item.next_action}`);
  }
  if (items.length >= 8) lines.push("나머지는 필요할 때 다시 보여드릴게요.");
  return lines.join("\n");
}

function hasContent(message) {
  return Boolean(
    String(message.text || message.caption || "").trim()
    || message.document || message.photo || message.video || message.voice,
  );
}

function latestReferenceRequest(text) {
  return /(?:방금|아까|최근|저장한\s*(?:거|것|항목))/.test(text)
    || /^(?:취소|삭제|완료|했어|끝냈어)/.test(text);
}

export function createInboxBotModule({
  send = sendMessage,
  contextForMessage = telegramMessageContext,
  classify = classifyInboxMessage,
  interpretReply = interpretInboxReply,
} = {}) {
  return {
    id: "inbox",
    help: "📥 Life Inbox\n아무 형식 없이 일정·할 일·링크·메모·사진·문서를 보내면 저장합니다. 수정과 취소는 저장 확인 메시지에 평소 말투로 답장하세요.\n/inbox : 지금 챙길 항목",
    commands: [{ command: "inbox", description: "📥 지금 챙길 생활 항목" }],

    async handleMessage(message) {
      if (!hasContent(message)) return false;
      const text = String(message.text || message.caption || "").trim();
      if (/^\/inbox(?:@\w+)?$/i.test(text) || /^(?:내가\s*)?저장한\s*(?:거|것|항목)\s*(?:보여\s*줘|목록)?[.!\s]*$/.test(text)) {
        await send(listMessage(listInboxItems({ limit: 8 })));
        return true;
      }
      if (/^\//.test(text)) return false;

      const replyMessageId = message.reply_to_message?.message_id;
      const replyContext = replyMessageId ? contextForMessage(replyMessageId) : null;
      let target = replyContext?.domain === "inbox" && replyContext.entityId
        ? getInboxItem(replyContext.entityId)
        : null;
      if (!target && latestReferenceRequest(text)) target = latestInboxItem();

      if (target) {
        const correction = await interpretReply(text, target);
        if (correction.action === "cancel") {
          const updated = updateInboxItem(target.id, { status: "cancelled" }, {
            reason: correction.reason, sourceMessageId: message.message_id,
          });
          await send(`🗑️ 취소했어요.\n${updated.title}`);
          return true;
        }
        if (correction.action === "complete") {
          const updated = updateInboxItem(target.id, { status: "completed" }, {
            reason: correction.reason, sourceMessageId: message.message_id,
          });
          await send(`✅ 완료로 기록했어요.\n${updated.title}`);
          return true;
        }
        if (correction.action === "update" && Object.keys(correction.changes).length) {
          const updated = updateInboxItem(target.id, correction.changes, {
            reason: correction.reason, sourceMessageId: message.message_id,
          });
          await send(itemMessage(updated, "고쳤어요"), {}, {
            context: { domain: "inbox", kind: "item", entityId: updated.id },
          });
          return true;
        }
        if (correction.action === "feedback") {
          recordFeedbackEvent({
            domain: "inbox", entityId: target.id,
            signal: correction.sentiment || "mixed", rawText: text,
            subjectType: "inbox_kind", subjectValue: target.kind,
            metadata: { kind: target.kind, classifier: correction.classifier },
            sourceKey: message.message_id ? `telegram:${message.message_id}` : null,
          });
          await send("👍 반영해둘게요. 별도 피드백 절차는 필요 없어요.");
          return true;
        }
        await send("이 항목을 어떻게 바꿀지 이해하지 못했어요. 예: ‘23일 오후 2시로 바꿔’ 또는 ‘취소해’. ");
        return true;
      }
      if (replyMessageId) return false;

      let result;
      try {
        result = await classify(message);
      } catch (error) {
        console.error("Life Inbox classification failed", error.message);
        await send("⚠️ 지금은 내용을 안전하게 분류하지 못해 저장하지 않았어요. 잠시 뒤 그대로 다시 보내 주세요.");
        return true;
      }
      if (result.intent === "not_inbox") return false;
      const item = createInboxItem({
        kind: result.kind, title: result.title, sourceText: text,
        sourceUrl: result.url, eventAt: result.eventAt, nextAction: result.nextAction,
        assumptions: result.assumptions, attachment: result.attachment,
        classifier: result.classifier, sourceMessageId: message.message_id,
      });
      await send(itemMessage(item), {}, {
        context: { domain: "inbox", kind: "item", entityId: item.id },
      });
      return true;
    },
  };
}

export const inboxBotModule = createInboxBotModule();
