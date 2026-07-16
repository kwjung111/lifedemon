import { classify, extractDates } from "./classify.mjs";

const endpoint = "https://apis.data.go.kr/1613000/HWSPR02/rsdtRcritNtcList";
const detailRoot = "https://www.myhome.go.kr/hws/portal/sch/selectRsdtRcritNtcDetailView.do";

const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
const first = (item, keys) => keys.map((key) => item?.[key]).find((value) => clean(value));

function itemList(payload) {
  const items = payload?.response?.body?.item
    ?? payload?.response?.body?.items?.item
    ?? payload?.body?.item
    ?? payload?.body?.items?.item
    ?? [];
  return Array.isArray(items) ? items : [items];
}

function toIsoDate(value) {
  const digits = clean(value).replace(/\D/g, "");
  return /^20\d{6}$/.test(digits)
    ? `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`
    : null;
}

function noticeFromItem(item, rules) {
  const title = clean(first(item, ["pblancNm", "pblancSj", "noticeTitle", "title"]));
  const noticeId = clean(first(item, ["pblancId", "pblancSn", "noticeId", "id"]));
  const suppliedUrl = clean(first(item, ["pblancUrl", "detailUrl", "url"]));
  if (!title) return null;

  const url = suppliedUrl.startsWith("http")
    ? suppliedUrl
    : noticeId ? `${detailRoot}?pblancId=${encodeURIComponent(noticeId)}` : endpoint;
  const rawText = JSON.stringify(item);
  const dates = extractDates(`${title} ${rawText}`);
  return {
    source: "마이홈 API",
    title,
    url,
    rawText,
    location: "서울",
    publishedAt: toIsoDate(item.rcritPblancDe) || dates.publishedAt,
    applyStart: toIsoDate(item.beginDe) || dates.applyStart,
    applyEnd: toIsoDate(item.endDe) || dates.applyEnd,
    announcementDate: toIsoDate(item.przwnerPresnatnDe) || dates.announcementDate,
    ...classify({ source: "마이홈", title, rawText, location: "서울", rules }),
  };
}

export async function collectMyHomeApi(rules) {
  const serviceKey = process.env.MYHOME_API_SERVICE_KEY;
  if (!serviceKey) return { notices: [], skipped: "MYHOME_API_SERVICE_KEY is not configured" };

  const url = new URL(endpoint);
  url.searchParams.set("serviceKey", serviceKey);
  url.searchParams.set("brtcCode", "11");
  url.searchParams.set("numOfRows", "100");
  url.searchParams.set("pageNo", "1");
  url.searchParams.set("_type", "json");

  let response;
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(45_000) });
      if (response.status < 500 || attempt === 3) break;
      lastError = new Error(`MyHome API HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
      if (attempt === 3) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
  }
  if (!response) throw lastError || new Error("MyHome API request failed");
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`MyHome API HTTP ${response.status}`);
  const resultCode = payload?.response?.header?.resultCode;
  if (resultCode && resultCode !== "00") throw new Error(`MyHome API ${resultCode}: ${payload.response.header.resultMsg || "request failed"}`);

  const noticesByPublicNotice = new Map();
  for (const item of itemList(payload)) {
    const notice = noticeFromItem(item, rules);
    if (!notice) continue;
    const key = clean(item.pblancId) || `${notice.title}\n${notice.url}`;
    noticesByPublicNotice.set(key, notice);
  }
  const notices = [...noticesByPublicNotice.values()];
  return { notices, skipped: null };
}
