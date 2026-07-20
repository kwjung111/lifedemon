const ordinalPatterns = [
  [1, /첫\s*번|첫\s*번째|첫째|처음(?:\s*거)?/],
  [2, /두\s*번|두\s*번째|둘째/],
  [3, /세\s*번|세\s*번째|셋째/],
  [4, /네\s*번|네\s*번째|넷째/],
  [5, /다섯\s*번|다섯\s*번째|다섯째/],
];

function compact(value) {
  return String(value || "").toLocaleLowerCase("ko-KR")
    .replace(/주식회사|㈜|\(주\)|\b주\b/g, "")
    .replace(/[^0-9a-z가-힣]/g, "");
}

function explicitIndex(text) {
  const digit = String(text || "").match(/(?:^|[^\d])(\d{1,2})\s*(?:번|번째)(?:[^\d]|$)/)?.[1];
  if (digit) return Number(digit);
  return ordinalPatterns.find(([, pattern]) => pattern.test(String(text || "")))?.[0] || null;
}

function namedMatches(text, items) {
  const normalizedText = compact(text);
  if (!normalizedText) return [];
  return items.filter((item) => {
    const company = compact(item.company);
    if (company.length >= 2 && normalizedText.includes(company)) return true;
    const source = compact(item.source);
    if (source.length >= 3 && normalizedText.includes(source)) return true;
    const titleTokens = String(item.title || "").match(/[0-9a-z가-힣]{3,}/gi) || [];
    const distinctive = titleTokens.filter((token) => !/청년|공고|채용|모집|엔지니어|주택/.test(token));
    return distinctive.some((token) => compact(token).length >= 4 && normalizedText.includes(compact(token)));
  });
}

export function resolveFeedbackTarget(text, items = []) {
  const candidates = items.filter(Boolean);
  const index = explicitIndex(text);
  if (index != null) {
    const item = candidates.find((candidate) => Number(candidate.index) === index) || null;
    return { item, reason: item ? "number" : "invalid_number", requestedIndex: index };
  }
  const named = namedMatches(text, candidates);
  if (named.length === 1) return { item: named[0], reason: "name", requestedIndex: null };
  if (named.length > 1) return { item: null, reason: "ambiguous_name", requestedIndex: null };
  if (candidates.length === 1) return { item: candidates[0], reason: "single", requestedIndex: null };
  return { item: null, reason: "missing_reference", requestedIndex: null };
}

export function feedbackTargetQuestion(items, resolution = {}) {
  if (resolution.reason === "invalid_number") {
    return `이 브리핑에는 ${items.length}개 공고가 있습니다. 1~${items.length}번 중에서 알려주세요.`;
  }
  return "어느 공고를 말하는지 한 번만 알려주세요. 예: ‘2번이 제일 나아’ 또는 회사명·공고 제목을 함께 말해 주세요.";
}
