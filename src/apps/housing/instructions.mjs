export const HOUSING_BASE_INSTRUCTION = `서울 기준으로 청년이 신청할 수 있는 공공임대, 청년 전세임대, 청년안심주택 공고를 공식 사이트(LH 청약플러스, SH 인터넷청약, 서울주거포털, 서울 청년안심주택 포털)에서 확인해 분석해서 보내줘.

신규 공고, 접수 중 공고, 접수 시작 예정, 마감 임박, 조건 변경을 구분한다. 각 공고마다 공급유형, 지역, 신청기간, 대상조건, 소득·자산 기준, 보증금·월세·관리비, 공급호수, 신청 링크, 주의사항을 요약한다. 단순 나열하지 않고 실제로 신청할 가치가 높은 순서대로 평가한다. 전날과 달라진 점이 없으면 ‘변경 없음’이라고 명확히 알린다.`;

export function parseRuleCommand(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith("/") && !/^\/rule(?:@\w+)?(?:\s+|$)/i.test(trimmed)) return null;
  const normalized = trimmed.replace(/^\/rule(?:@\w+)?(?:\s+|$)/i, "");
  const deleteMatch = normalized.match(/^삭제\s+(\d+)$/);
  if (deleteMatch) return { action: "delete", id: Number(deleteMatch[1]) };

  const excludeMatch = normalized.match(/^(.+?)(?:은|는)?\s*(?:앞으로\s*)?제외(?:해|해줘|한다|하기)?[.!]?$/);
  if (!excludeMatch) return null;
  const keyword = excludeMatch[1].trim().replace(/^['“”]|['“”]$/g, "");
  if (!keyword || keyword.length > 80) return null;
  return { action: "add", kind: "exclude_keyword", keyword, text: `${keyword} 제외` };
}
