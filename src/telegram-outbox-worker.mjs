import { flushTelegramOutbox } from "./telegram.mjs";

console.log("Telegram outbox worker started");
while (true) {
  try {
    const result = await flushTelegramOutbox();
    if (result.delivered || result.rescheduled || result.failed) console.log("Telegram outbox pass", result);
  } catch (error) {
    console.error(new Date().toISOString(), error.message);
  }
  await new Promise((resolve) => setTimeout(resolve, 30_000));
}
