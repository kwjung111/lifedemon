export function createBotRuntime({
  telegram,
  sendMessage,
  allowedChatId,
  modules,
  loadOffset,
  saveOffset,
  beginUpdate = () => ({ status: "processing", attempts: 1 }),
  completeUpdate = () => null,
  failUpdate = () => ({ status: "pending", attempts: 1 }),
  allowedUserId = allowedChatId,
  messageContext = () => null,
  interpretMessage = null,
  log = console.log,
}) {
  const allowedChat = String(allowedChatId);
  const allowedUser = String(allowedUserId);

  function authorized({ chat, from }) {
    return String(chat?.id || "") === allowedChat
      && String(from?.id || "") === allowedUser
      && chat?.type === "private";
  }

  async function handleCallback(query) {
    if (!authorized({ chat: query.message?.chat, from: query.from })) {
      await telegram("answerCallbackQuery", {
        callback_query_id: query.id,
        text: "권한이 없습니다.",
      });
      return;
    }

    const module = modules.find((candidate) => candidate.canHandleCallback?.(query));
    if (module) return module.handleCallback(query);
    return telegram("answerCallbackQuery", {
      callback_query_id: query.id,
      text: "처리할 수 없는 버튼입니다.",
    });
  }

  async function handleMessage(message) {
    if (!authorized(message)) return;
    const text = String(message.text || message.caption || "").trim();
    const hasAttachment = Boolean(message.document || message.photo || message.video || message.voice);
    if (!text && !hasAttachment) return;
    const routeMeta = {
      messageId: message.message_id || null,
      replyToMessageId: message.reply_to_message?.message_id || null,
      itemNumber: Number(text.match(/^\s*(\d{1,2})\s*번?/)?.[1] || 0) || null,
    };

    const baseContext = routeMeta.replyToMessageId ? messageContext(routeMeta.replyToMessageId) : null;
    const command = text.startsWith("/")
      ? text.slice(1).split(/\s/, 1)[0].split("@", 1)[0].toLowerCase()
      : null;
    const fixedCommands = new Set([
      "start", "help", "manual", "briefing", "inbox", "reminders", "calendar", "calendar_status",
      "housing", "housing_status", "housing_guide", "housing_instructions", "housing_rules", "rules",
      "jobs", "job_status", "jobs_status", "feedback", "feedback_rules", "daemon", "system", "ask",
    ]);
    const strictReminderCommand = command === "remind"
      && /^\/remind(?:@\w+)?\s+20\d{2}-\d{2}-\d{2}\s+\d{1,2}:\d{2}\s+\S/.test(text);
    let semantic = null;
    if (interpretMessage && !strictReminderCommand && (!command || !fixedCommands.has(command))) {
      try {
        telegram("sendChatAction", { chat_id: message.chat.id, action: "typing" }).catch(() => {});
        semantic = await interpretMessage(message, baseContext);
      } catch (error) {
        log("Telegram message interpretation failed", { ...routeMeta, error: error.message });
        await sendMessage("자연어 해석기가 잠시 응답하지 않아 아무 작업도 실행하지 않았어요. 잠시 후 다시 보내 주세요.");
        return;
      }
      if (semantic.route === "not_supported") {
        await sendMessage(semantic.clarification || "요청을 확실히 이해하지 못했어요. 조금만 더 구체적으로 말해 주세요.");
        log("Telegram message needs clarification", { ...routeMeta, route: semantic.route });
        return;
      }
    }
    const context = semantic ? { ...(baseContext || {}), semantic } : baseContext;
    const priority = modules.filter((module) => module.canHandleMessage?.(message, context));
    const orderedModules = [...priority, ...modules.filter((module) => !priority.includes(module))];
    for (const module of orderedModules) {
      if (await module.handleMessage(message, context)) {
        log("Telegram message routed", { ...routeMeta, module: module.id });
        return;
      }
    }
    log("Telegram message unhandled", routeMeta);
    if (routeMeta.itemNumber && !routeMeta.replyToMessageId) {
      await sendMessage("공고 번호는 브리핑마다 다시 시작합니다. 공고 목록 말풍선을 왼쪽으로 밀어 ‘답장’을 선택한 뒤 같은 문장을 보내 주세요.");
      return;
    }
    if (routeMeta.replyToMessageId) {
      await sendMessage("답장한 메시지가 저장된 공고 브리핑과 연결되지 않았습니다. 번호가 붙은 공고 목록 말풍선 자체에 답장해 주세요.");
      return;
    }
    await sendMessage("요청을 이해하지 못했어요. /help에서 가장 쉬운 사용법을 확인해 주세요.");
  }

  async function handleUpdate(update) {
    const inbox = beginUpdate(update);
    if (["done", "dead"].includes(inbox.status)) return { committed: true, skipped: true };
    try {
      if (update.callback_query) await handleCallback(update.callback_query);
      if (update.message) await handleMessage(update.message);
      completeUpdate(update.update_id);
      return { committed: true, skipped: false };
    } catch (error) {
      const failed = failUpdate(update.update_id, error.message);
      if (failed.status !== "dead") throw error;
      try {
        await sendMessage(
          `⚠️ Telegram 요청 처리에 3회 실패해 보류했습니다.\nupdate ${update.update_id}\n${error.message}`,
          {},
          { dedupeKey: `telegram-update-dead:${update.update_id}` },
        );
      } catch (alertError) {
        log(`Dead-update alert queued but not delivered yet: ${alertError.message}`);
      }
      return { committed: true, dead: true };
    }
  }

  async function run() {
    let offset = Number(loadOffset() || 0);
    console.log(`Telegram gateway started with ${modules.length} module(s) for chat ${allowedChat.slice(0, 3)}***`);
    while (true) {
      try {
        const updates = await telegram("getUpdates", {
          offset,
          timeout: 30,
          allowed_updates: ["message", "callback_query"],
        });
        for (const update of updates) {
          try {
            const result = await handleUpdate(update);
            if (!result.committed) continue;
            offset = update.update_id + 1;
            saveOffset(offset);
          } catch (error) { throw error; }
        }
      } catch (error) {
        console.error(new Date().toISOString(), error.message);
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }

  return { run, handleMessage, handleCallback, handleUpdate, authorized };
}
