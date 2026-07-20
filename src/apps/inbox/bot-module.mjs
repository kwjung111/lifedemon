import { telegramMessageContext } from "../../core/state.mjs";
import { sendMessage, telegram } from "../../telegram.mjs";
import { proposeReminder } from "../reminders/service.mjs";
import {
  countInboxItems, createInboxItem, getInboxItem, inboxItemForSourceMessage,
  inboxRevisionForSource, listInboxItems, updateInboxItem,
} from "./store.mjs";

const kindLabels = {
  event: "일정", task: "할 일", watch: "확인할 것", note: "메모", reference: "참고자료",
};
const pageSize = 8;
const inboxRoutes = new Set([
  "inbox_create", "inbox_list", "inbox_next", "inbox_update", "inbox_complete",
  "inbox_cancel", "inbox_show", "inbox_reminder",
]);
const escapeHtml = (value) => String(value || "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function commandName(text) {
  if (!text.startsWith("/")) return null;
  return text.slice(1).split(/\s/, 1)[0].split("@", 1)[0].toLowerCase();
}

function kstDateTime(value) {
  if (!value) return null;
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul", year: "numeric", month: "numeric", day: "numeric",
    weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(value));
}

function itemMessage(item, lead = "저장했어요") {
  const lines = [`📥 ${kindLabels[item.kind] || "항목"} ${lead.replace(/했어요/, "")}`.trim()];
  lines.push(item.event_at ? `${kstDateTime(item.event_at)} · ${item.title}` : item.title);
  if (item.kind === "event") lines.push("알림은 자동 등록하지 않아요. 필요하면 이 메시지에 ‘알림도 등록해’라고 답장하세요.");
  else if (item.next_action.replace(/\s+/g, "") !== item.title.replace(/\s+/g, "")) lines.push(`다음: ${item.next_action}`);
  if (item.source_url) lines.push(item.source_url);
  if (item.assumptions?.length) lines.push(`확인 필요: ${item.assumptions.slice(0, 2).join(" · ")}`);
  lines.push("이 메시지에 답장해서 수정·완료·취소할 수 있어요.");
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
  lines.push("", "항목을 고치거나 끝내려면 이 목록에 답장해 주세요.");
  if (offset + items.length < total) lines.push("다음 목록은 ‘더 보여줘’라고 답장하세요.");
  return lines.join("\n");
}

function contextItems(context) {
  return (context?.items || []).filter((item) => item.domain === "inbox" || context?.domain === "inbox");
}

function targetFromSemantic(context) {
  if (context?.domain === "inbox" && context.entityId) return getInboxItem(context.entityId);
  const index = Number(context?.semantic?.targetIndex);
  const item = contextItems(context).find((candidate) => Number(candidate.index) === index);
  return item ? getInboxItem(item.id) : null;
}

function attachmentFromMessage(message) {
  if (message.document) return {
    type: "document", fileId: message.document.file_id, fileName: message.document.file_name || null,
    mimeType: message.document.mime_type || null, size: message.document.file_size || null,
  };
  const photo = Array.isArray(message.photo) ? message.photo.at(-1) : null;
  if (photo) return { type: "photo", fileId: photo.file_id, size: photo.file_size || null };
  if (message.video) return { type: "video", fileId: message.video.file_id, mimeType: message.video.mime_type || null };
  if (message.voice) return { type: "voice", fileId: message.voice.file_id, mimeType: message.voice.mime_type || null };
  return null;
}

export function createInboxBotModule({
  send = sendMessage,
  contextForMessage = telegramMessageContext,
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

  async function showItem(target, message) {
    if (target.attachment?.fileId) {
      const methods = {
        document: ["sendDocument", "document"], photo: ["sendPhoto", "photo"],
        video: ["sendVideo", "video"], voice: ["sendVoice", "voice"],
      };
      const [method, field] = methods[target.attachment.type] || [];
      if (method) {
        await telegramApi(method, {
          chat_id: message.chat.id, [field]: target.attachment.fileId,
          caption: `${target.title}${target.source_url ? `\n${target.source_url}` : ""}`.slice(0, 900),
        });
        return;
      }
    }
    if (target.source_url) await send(`🔗 ${target.title}\n${target.source_url}`);
    else await send(itemMessage(target, "상세 내용이에요"));
  }

  return {
    id: "inbox",
    help: "📥 Life Inbox\n형식 없이 일정·할 일·링크·메모·사진·문서를 보내면 AI가 한 번 해석한 뒤 저장합니다. 저장 확인 메시지에 답장해서 수정·완료·취소하세요.\n/inbox : 지금 챙길 항목",
    commands: [{ command: "inbox", description: "📥 저장한 일정·할 일" }],

    canHandleMessage(_message, context) {
      return inboxRoutes.has(context?.semantic?.route);
    },

    async handleMessage(message, routedContext = null) {
      const text = String(message.text || message.caption || "").trim();
      if (commandName(text) === "inbox") {
        await sendListPage([]);
        return true;
      }
      if (commandName(text)) return false;
      const replyMessageId = message.reply_to_message?.message_id;
      const context = routedContext || (replyMessageId ? contextForMessage(replyMessageId) : null);
      const semantic = context?.semantic;
      if (!inboxRoutes.has(semantic?.route)) return false;

      if (semantic.route === "inbox_list") {
        await sendListPage([]);
        return true;
      }
      if (semantic.route === "inbox_next") {
        await sendListPage(context?.seenIds || contextItems(context).map((item) => item.id));
        return true;
      }
      if (semantic.route === "inbox_create") {
        const replayed = inboxItemForSourceMessage(message.message_id);
        if (replayed) {
          await send(itemMessage(replayed, "이미 저장했어요"), {}, {
            context: { domain: "inbox", kind: "item", entityId: replayed.id },
          });
          return true;
        }
        const attachment = attachmentFromMessage(message);
        const item = createInboxItem({
          kind: semantic.kind || (attachment ? "reference" : "note"),
          title: semantic.title || attachment?.fileName || "메모",
          sourceText: text,
          sourceUrl: semantic.url,
          eventAt: semantic.eventAt,
          nextAction: semantic.nextAction || "내용 확인",
          assumptions: semantic.assumptions,
          attachment,
          classifier: "global-ai",
          sourceMessageId: message.message_id,
        });
        await send(itemMessage(item), {}, {
          context: { domain: "inbox", kind: "item", entityId: item.id },
        });
        return true;
      }

      const target = targetFromSemantic(context);
      if (!target) {
        await send("어느 항목인지 찾지 못했어요. /inbox 목록의 해당 항목에 답장해 주세요.");
        return true;
      }
      if (semantic.route === "inbox_show") {
        await showItem(target, message);
        return true;
      }
      if (semantic.route === "inbox_reminder") {
        if (!target.event_at || Date.parse(target.event_at) <= Date.now()) {
          await send("미래 날짜와 시간이 있는 일정만 알림으로 등록할 수 있어요. 먼저 일정을 고쳐 주세요.");
          return true;
        }
        await propose({
          title: target.title, dueAt: target.event_at, url: target.source_url,
          module: "global", entityKey: `inbox:${target.id}:${target.event_at}`,
          metadata: { domain: "inbox", entityId: target.id, source: "life-inbox" },
        });
        return true;
      }
      if (inboxRevisionForSource(target.id, message.message_id)) {
        await send(itemMessage(getInboxItem(target.id), "이미 반영했어요"), {}, {
          context: { domain: "inbox", kind: "item", entityId: target.id },
        });
        return true;
      }
      if (["inbox_cancel", "inbox_complete"].includes(semantic.route)) {
        const status = semantic.route === "inbox_cancel" ? "cancelled" : "completed";
        const updated = updateInboxItem(target.id, { status }, {
          reason: semantic.reason, sourceMessageId: message.message_id,
        });
        await send(`${status === "cancelled" ? "🗑️ 취소했어요" : "✅ 완료로 기록했어요"}\n${updated.title}`);
        return true;
      }
      const changes = {};
      if (semantic.title) changes.title = semantic.title;
      if (semantic.kind) changes.kind = semantic.kind;
      if (semantic.clearEventAt) changes.eventAt = null;
      else if (semantic.eventAt) changes.eventAt = semantic.eventAt;
      if (semantic.nextAction) changes.nextAction = semantic.nextAction;
      if (semantic.assumptions?.length) changes.assumptions = semantic.assumptions;
      if (!Object.keys(changes).length) {
        await send("바꿀 내용을 찾지 못했어요. 변경할 항목을 조금 더 구체적으로 말해 주세요.");
        return true;
      }
      const updated = updateInboxItem(target.id, changes, {
        reason: semantic.reason, sourceMessageId: message.message_id,
      });
      await send(itemMessage(updated, "고쳤어요"), {}, {
        context: { domain: "inbox", kind: "item", entityId: updated.id },
      });
      return true;
    },
  };
}

export const inboxBotModule = createInboxBotModule();
