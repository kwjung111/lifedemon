import { chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export function wantedSessionStatus({ url = "", hasLoginButton = false, hasMyWanted = false } = {}) {
  if (hasMyWanted) return "signed_in";
  if (hasLoginButton || /\/login(?:[/?#]|$)/i.test(url)) return "signed_out";
  return "unknown";
}

export async function detectWantedSession(page) {
  const [hasLoginButton, hasMyWanted] = await Promise.all([
    page.getByRole("button", { name: "회원가입/로그인" }).count().then((count) => count > 0).catch(() => false),
    page.getByRole("link", { name: "MY 원티드" }).count().then((count) => count > 0).catch(() => false),
  ]);
  return wantedSessionStatus({ url: page.url(), hasLoginButton, hasMyWanted });
}

export async function saveWantedSession(context, path) {
  await mkdir(dirname(path), { recursive: true });
  await context.storageState({ path });
  await chmod(path, 0o600).catch(() => {});
}
