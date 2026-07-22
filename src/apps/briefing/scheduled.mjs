import { morningBriefingSnapshot, sendMorningBriefing } from "./report.mjs";

const sleepFor = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function waitForMorningBriefingReadiness({
  timeoutMs = 50 * 60_000,
  pollMs = 2 * 60_000,
  snapshot = () => morningBriefingSnapshot(),
  sleep = sleepFor,
  clock = () => Date.now(),
} = {}) {
  const startedAt = clock();
  let current = snapshot();
  while (!current.readiness.ready && !current.readiness.settled && clock() - startedAt < timeoutMs) {
    await sleep(Math.min(pollMs, Math.max(0, timeoutMs - (clock() - startedAt))));
    current = snapshot();
  }
  return { snapshot: current, timedOut: !current.readiness.ready && !current.readiness.settled };
}

export async function runScheduledMorningBriefing(options = {}) {
  const result = await waitForMorningBriefingReadiness(options);
  const deliveryKey = briefingDeliveryKey(result.snapshot);
  const message = await sendMorningBriefing({ snapshot: result.snapshot, deliveryKey });
  return { ...result, deliveryKey, message };
}

export function briefingDeliveryKey(snapshot) {
  return snapshot.readiness.ready
    ? `morning-briefing:${snapshot.date}`
    : `morning-briefing-blocked:${snapshot.date}`;
}
