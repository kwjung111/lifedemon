import { classify, extractDates } from "./classify.mjs";

const endpoint = "https://apis.data.go.kr/1613000/HWSPR02/rsdtRcritNtcList";
const detailRoot = "https://www.myhome.go.kr/hws/portal/sch/selectRsdtRcritNtcDetailView.do";

const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
const first = (item, keys) => keys.map((key) => item?.[key]).find((value) => clean(value));

function itemList(payload) {
  const items = payload?.response?.body?.items?.item ?? payload?.body?.items?.item ?? [];
  return Array.isArray(items) ? items : [items];
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
  return {
    source: "마이홈 API",
    title,
    url,
    rawText,
    location: "서울",
    ...extractDates(`${title} ${rawText}`),
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

  const response = await fetch(url, { signal: AbortSignal.timeout(45_000) });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`MyHome API HTTP ${response.status}`);
  const resultCode = payload?.response?.header?.resultCode;
  if (resultCode && resultCode !== "00") throw new Error(`MyHome API ${resultCode}: ${payload.response.header.resultMsg || "request failed"}`);

  const notices = itemList(payload).map((item) => noticeFromItem(item, rules)).filter(Boolean);
  return { notices, skipped: null };
}
