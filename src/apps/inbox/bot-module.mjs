import { recordFeedbackEvent, telegramMessageContext } from "../../core/state.mjs";
import { sendMessage, telegram } from "../../telegram.mjs";
import { classifyInboxMessage, hasInvalidExplicitDate } from "./classifier.mjs";
import { interpretInboxReply } from "./correction.mjs";
import { proposeReminder } from "../reminders/service.mjs";
import {
  countInboxItems, createInboxItem, getInboxItem, inboxItemForSourceMessage,
  inboxRevisionForSource, latestInboxItem, listInboxItems, updateInboxItem,
} from "./store.mjs";

const kindLabels = {
  event: "일정", task: "할 일", watch: "확인할 것", note: "메모", reference: "참고자료",
};
const pageSize = 8;
const escapeHtml = (value) => String(value || "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function kstDateTime(value) {
  if (!value) return null;
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul", year: "numeric", month: "numeric", day: "numeric",
    weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(value));
}

function itemMessage(item, lead = "저장했어요") {
  const lines = [`✅ ${kindLabels[item.kind] || "항목"} ${lead.replace(/했어요$/, "")}`];
  lines.push(item.event_at ? `${kstDateTime(item.event_at)} · ${item.title}` : item.title);
  if (item.kind === "event") lines.push("정시 알림은 등록되지 않았어요. 알림이 필요하면 ‘알림도 등록해’라고 답장하세요.");
  else if (item.next_action.replace(/\s+/g, "") !== item.title.replace(/\s+/g, "")) lines.push(`다음: ${item.next_action}`);
  if (item.source_url) lines.push(item.source_url);
  if (item.assumptions?.length) lines.push(`확인 안 된 점: ${item.assumptions.slice(0, 2).join(" · ")}`);
  lines.push("↩️ 이 말풍선의 답장 기능으로 수정·완료·취소");
  return lines.join("\n");
}

function listMessage(items, { offset = 0, total = items.length } = {}) {
  if (!items.length) return "📥 저장된 생활 항목이 없어요.";
  const lines = [`📥 지금 챙길 것 ${offset + 1}–${offset + items.length} / ${total}`];
  for (const [index, item] of items.entries()) {
    const at = item.event_at ? ` · ${kstDateTime(item.event_at)}` : "";
    const past = item.event_at && Date.parse(item.event_at) < Date.now() ? "지난 일정 · " : "";
    const title = item.source_url
      ? `<a href="${escapeHtml(item.source_url)}">${escapeHtml(item.title)}</a>`
      : escapeHtml(item.title);
    const attachment = item.attachment ? " · 첨부" : "";
    lines.push(`${index + 1}. ${past}${title}${escapeHtml(at)}${attachment}\n   다음: ${escapeHtml(item.next_action)}`);
  }
  lines.push("", "↩️ 이 목록에 답장: ‘2번 완료’ · ‘1번 23일로 변경’ · ‘2번 보여줘’");
  if (offset + items.length < total) lines.push("다음 목록: ‘더 보여줘’라고 답장");
  return lines.join("\n");
}

function contextItems(context) {
  return (context?.items || []).filter((item) => item.domain === "inbox");
}

function targetFromContext(context, text) {
  if (context?.domain === "inbox" && context.entityId) return getInboxItem(context.entityId);
  const items = contextItems(context);
  const number = Number(String(text).match(/(?:^|\s)(\d{1,2})\s*번?/)?.[1] || 0);
  const numbered = items.find((item) => Number(item.index) === number);
  if (numbered) return getInboxItem(numbered.id);
  const compact = String(text).replace(/\s+/g, "");
  const named = items.filter((item) => {
    const title = String(item.title || "").replace(/\s+/g, "");
    return title.length >= 3 && compact.includes(title.slice(0, Math.min(12, title.length)));
  });
  if (named.length === 1) return getInboxItem(named[0].id);
  if (items.length === 1 && /^(?:완료|취소|삭제|보여줘|열어줘)/.test(String(text).trim())) return getInboxItem(items[0].id);
  return null;
}

function correctionText(text) {
  return String(text).replace(/^\s*\d{1,2}\s*번(?:을|은|이|을)?\s*/, "").trim();
}

function isShowRequest(text) {
  return /(?:보여\s*줘|열어\s*줘|링크|파일|첨부)/.test(String(text));
}

function hasContent(message) {
  return Boolean(
    String(message.text || message.caption || "").trim()
    || message.document || message.photo || message.video || message.voice,
  );
}

function latestReferenceRequest(text) {
  return /(?:방금|아까|최근|저장한\s*(?:거|것|항목))/.test(text);
}

function standaloneAction(text) {
  return /^(?:취소|삭제|완료|했어|끝냈어|처리했어)[.!\s]*$/.test(String(text).trim());
}

export function createInboxBotModule({
  send = sendMessage,
  contextForMessage = telegramMessageContext,
  classify = classifyInboxMessage,
  interpretReply = interpretInboxReply,
  telegramApi = telegram,
  propose = proposeReminder,
} = {}) {
  async function sendListPage(seenIds = []) {
    const total = countInboxItems();
    const seen = new Set((seenIds || []).map(Number));
    const items = listInboxItems({ limit: 100 }).filter((item) => !seen.has(item.id)).slice(0, pageSize);
    if (!items.length && seen.size) return send("📥 더 보여드릴 활성 항목이 없어요.");
    const nextSeenIds = [...seen, ...items.map((item) => item.id)];
    return send(listMessage(items, { offset: seen.size, total }), { parse_mode: "HTML" }, {
      context: {
        domain: "inbox", kind: "list", offset: seen.size, total, seenIds: nextSeenIds,
        items: items.map((item, index) => ({ index: index + 1, id: item.id, domain: "inbox", title: item.title })),
      },
    });
  }

  return {
    id: "inbox",
    help: "📥 Life Inbox\n아무 형식 없이 일정·할 일·링크·메모·사진·문서를 보내면 저장합니다. 수정과 취소는 저장 확인 메시지에 평소 말투로 답장하세요.\n/inbox : 지금 챙길 항목",
    commands: [{ command: "inbox", description: "📥 저장한 일정·할 일" }],

    canHandleMessage(message, context) {
      if (context?.domain === "inbox") return true;
      const text = message.text || message.caption || "";
      return Boolean(targetFromContext(context, text))
        || (contextItems(context).length > 0 && /(?:완료|취소|삭제|변경|바꿔)/.test(text));
    },

    async handleMessage(message, routedContext = null) {
      if (!hasContent(message)) return false;
      const text = String(message.text || message.caption || "").trim();
      if (/^\/inbox(?:@\w+)?$/i.test(text) || /^(?:내가\s*)?저장한\s*(?:거|것|항목)\s*(?:보여\s*줘|목록)?[.!\s]*$/.test(text)) {
        await sendListPage([]);
        return true;
      }
      if (/^\//.test(text)) return false;

      const replyMessageId = message.reply_to_message?.message_id;
      const replyContext = routedContext || (replyMessageId ? contextForMessage(replyMessageId) : null);
      if (replyContext?.domain === "inbox" && replyContext.kind === "list" && /(?:더\s*보여\s*줘|다음)/.test(text)) {
        await sendListPage(replyContext.seenIds || contextItems(replyContext).map((item) => item.id));
        return true;
      }
      let target = targetFromContext(replyContext, text);
      if (!target && latestReferenceRequest(text)) target = latestInboxItem({ activeOnly: true });
      if (!target && standaloneAction(text)) {
        if (countInboxItems() === 1) target = latestInboxItem({ activeOnly: true });
        else {
          await send("어느 항목인지 선택해야 해요. /inbox 목록에 ‘2번 완료’처럼 답장해 주세요.");
          return true;
        }
      }

      if (target) {
        if (inboxRevisionForSource(target.id, message.message_id)) {
          await send(itemMessage(getInboxItem(target.id), "이미 반영했어요"));
          return true;
        }
        if (isShowRequest(text)) {
          if (target.source_url) await send(`🔗 ${target.title}\n${target.source_url}`);
          else if (target.attachment?.fileId) {
            const methods = { document: ["sendDocument", "document"], photo: ["sendPhoto", "photo"], video: ["sendVideo", "video"], voice: ["sendVoice", "voice"] };
            const [method, field] = methods[target.attachment.type] || [];
            if (method) await telegramApi(method, {
              chat_id: message.chat.id, [field]: target.attachment.fileId, caption: target.title.slice(0, 900),
            });
          } else await send(itemMessage(target, "상세 내용이에요"));
          return true;
        }
        if (target.kind === "event" && /(?:알림.*등록|알려\s*줘|리마인드)/.test(text)) {
          if (!target.event_at) {
            await send("알림 날짜와 시간이 아직 없어요. 먼저 ‘23일 오후 2시로 바꿔’처럼 답장해 주세요.");
            return true;
          }
          if (Date.parse(target.event_at) <= Date.now()) {
            await send("지난 일정에는 새 알림을 등록할 수 없어요. 날짜를 먼저 고쳐 주세요.");
            return true;
          }
          await propose({
            title: target.title, dueAt: target.event_at, url: target.source_url,
            module: "global", entityKey: `inbox:${target.id}:${target.event_at}`,
            metadata: { domain: "inbox", entityId: target.id, source: "life-inbox" },
          });
          return true;
        }
        const naturalCorrection = correctionText(text);
        if (hasInvalidExplicitDate(naturalCorrection)) {
          await send("📅 존재하지 않는 날짜라 변경하지 않았어요. 날짜를 확인해 주세요.");
          return true;
        }
        const correction = await interpretReply(naturalCorrection, target);
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
            subjectType: "inbox_item", subjectValue: target.title,
            metadata: { kind: target.kind, classifier: correction.classifier },
            sourceKey: message.message_id ? `telegram:${message.message_id}` : null,
          });
          await send("👍 반영해둘게요. 별도 피드백 절차는 필요 없어요.");
          return true;
        }
        await send("이 항목을 어떻게 바꿀지 이해하지 못했어요. 예: ‘23일 오후 2시로 바꿔’ 또는 ‘취소해’. ");
        return true;
      }
      if (replyContext?.domain === "inbox" || contextItems(replyContext).length) {
        await send("어느 항목인지 번호를 붙여 주세요. 예: ‘2번 완료’. ");
        return true;
      }
      if (replyMessageId) return false;

      const replayed = inboxItemForSourceMessage(message.message_id);
      if (replayed) {
        await send(itemMessage(replayed, "이미 저장했어요"), {}, {
          context: { domain: "inbox", kind: "item", entityId: replayed.id },
        });
        return true;
      }

      let result;
      try {
        result = await classify(message);
      } catch (error) {
        console.error("Life Inbox classification failed", error.message);
        await send("⚠️ 지금은 내용을 안전하게 분류하지 못해 저장하지 않았어요. 잠시 뒤 그대로 다시 보내 주세요.");
        return true;
      }
      if (result.intent === "not_inbox") return false;
      if (result.intent === "invalid_date") {
        await send("📅 존재하지 않는 날짜라 저장하지 않았어요. 날짜를 확인해 다시 보내 주세요.");
        return true;
      }
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
