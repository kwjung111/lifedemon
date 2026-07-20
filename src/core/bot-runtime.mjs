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

    if (/^\/help(?:@\w+)?$/i.test(text)) {
      const help = modules.map((module) => module.help).filter(Boolean).join("\n\n");
      await sendMessage(`사용 가능한 알림\n\n${help}`);
      return;
    }

    for (const module of modules) {
      if (await module.handleMessage(message)) {
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
    await sendMessage("어떤 알림에 대한 요청인지 확인하지 못했습니다. /help를 보내 사용법을 확인해 주세요.");
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
