const token = process.env.TELEGRAM_BOT_TOKEN;
export const chatId = String(process.env.TELEGRAM_CHAT_ID || "");

if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required");
if (!chatId) throw new Error("TELEGRAM_CHAT_ID is required");

export async function telegram(method, payload = {}) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(45_000),
      });
      const result = await response.json().catch(() => null);
      if (response.ok && result?.ok) return result.result;
      lastError = new Error(`${method} failed: ${result?.description || `HTTP ${response.status}`}`);
      if (response.status < 500 && response.status !== 429) throw lastError;
    } catch (error) {
      lastError = error;
    }
    if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
  }
  throw lastError;
}

export const sendMessage = (text, extra = {}) => telegram("sendMessage", {
  chat_id: chatId,
  text,
  disable_web_page_preview: true,
  ...extra,
});
