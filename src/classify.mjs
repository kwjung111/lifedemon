const closedPattern = /당첨자|경쟁률|서류심사|대상자\s*발표|결과\s*발표|청약\s*마감|접수\s*마감|공급완료|계약결과/;
const excludedPattern = /신혼|신생아|다자녀|고령자|실버|기관추천|장애인\s*특별공급/;
const youthPattern = /청년|대학생|기숙사형|청년안심주택/;
const publicPattern = /국민임대|공공임대|행복주택|매입임대|전세임대|영구임대|든든전세|지원주택/;
const affordablePattern = /민간임대|전세|월세|임대주택|잔여세대|예비입주자/;
const seoulPattern = /서울|강남|강동|강북|강서|관악|광진|구로|금천|노원|도봉|동대문|동작|마포|서대문|서초|성동|성북|송파|양천|영등포|용산|은평|종로|중구|중랑/;

function toIsoDate(value) {
  if (!value) return null;
  const match = value.match(/(20\d{2})[.\/-]\s*(\d{1,2})[.\/-]\s*(\d{1,2})/);
  if (!match) return null;
  return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
}

export function extractDates(text) {
  const normalized = text
    .replace(/(20\d{2})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일/g, "$1.$2.$3")
    .replace(/\s+/g, " ");
  const range = normalized.match(/(?:접수|신청|청약)[^\d]{0,30}(20\d{2})[.\/-]\s*(\d{1,2})[.\/-]\s*(\d{1,2})[^\d]{0,12}(?:(20\d{2})[.\/-]\s*)?(\d{1,2})[.\/-]\s*(\d{1,2})/)
    || normalized.match(/(?:접수|신청|청약).{0,120}?(20\d{2})[.\/-]\s*(\d{1,2})[.\/-]\s*(\d{1,2}).{0,100}?(?:(20\d{2})[.\/-]\s*)?(\d{1,2})[.\/-]\s*(\d{1,2})/);
  const announcement = normalized.match(/(?:당첨자\s*발표|발표일)[^\d]{0,30}(20\d{2}[.\/-]\s*\d{1,2}[.\/-]\s*\d{1,2})/);
  const published = normalized.match(/(?:공고일|게시일|등록일)?[^\d]{0,5}(20\d{2}[.\/-]\s*\d{1,2}[.\/-]\s*\d{1,2})/);
  return {
    publishedAt: toIsoDate(published?.[1]),
    applyStart: range ? `${range[1]}-${range[2].padStart(2, "0")}-${range[3].padStart(2, "0")}` : null,
    applyEnd: range ? `${range[4] || range[1]}-${range[5].padStart(2, "0")}-${range[6].padStart(2, "0")}` : null,
    announcementDate: toIsoDate(announcement?.[1]),
  };
}

export function classify({ source, title, rawText = "", location = "", rules = [] }) {
  const text = `${title} ${rawText}`.replace(/\s+/g, " ");
  const reasons = [];
  const categories = [];

  const matchedRule = rules.find((rule) =>
    rule.kind === "exclude_keyword" && text.toLocaleLowerCase("ko-KR").includes(rule.keyword.toLocaleLowerCase("ko-KR"))
  );
  if (matchedRule) {
    return { verdict: "exclude", categories, reasons: [`사용자 지침 적용: ${matchedRule.instruction}`] };
  }

  if (closedPattern.test(title)) {
    return { verdict: "exclude", categories, reasons: ["모집이 아닌 발표·마감·경쟁률 게시로 판단"] };
  }

  if (youthPattern.test(text)) categories.push("청년이 신청할 수 있는 저렴한 임대주택");
  if (publicPattern.test(text)) categories.push("무주택 1인 가구가 검토할 공공임대");
  if (affordablePattern.test(text) || source === "HUG") categories.push("시세보다 저렴한 전세 또는 월세 주택");

  const isSeoul = source === "SH" || source === "청년안심주택" || seoulPattern.test(`${title} ${location}`);
  if (isSeoul) reasons.push("서울 소재 또는 서울 공급 공고");
  else if (source === "HUG") reasons.push("HUG 공고 내 서울 물건 포함 여부 추가 확인 필요");
  else reasons.push("제목에서 서울 소재 여부 추가 확인 필요");

  if (excludedPattern.test(title) && !youthPattern.test(title)) {
    return { verdict: "exclude", categories, reasons: [...reasons, "1인 청년 대상이 아닌 전용 유형으로 판단"] };
  }

  if (youthPattern.test(text) && isSeoul) {
    reasons.push("청년 또는 대학생 신청 유형이 명시됨");
    reasons.push("소득·자산·무주택 세부요건은 공고문 확인 필요");
    return { verdict: "likely", categories: [...new Set(categories)], reasons };
  }

  if (publicPattern.test(text) || source === "HUG") {
    reasons.push("공공·공공지원 임대 유형으로 1인 가구 공급형 확인 필요");
    reasons.push("연령·소득·자산·세대구성 세부요건은 공고문 확인 필요");
    return { verdict: isSeoul || source === "HUG" ? "possible" : "review", categories: [...new Set(categories)], reasons };
  }

  if (source === "SH" || source === "청년안심주택") {
    reasons.push("서울 임대 공고이나 1인 청년 공급형 여부 확인 필요");
    return {
      verdict: /잔여세대|입주자\s*모집/.test(title) ? "possible" : "review",
      categories: [...new Set(categories)],
      reasons,
    };
  }

  return { verdict: "exclude", categories: [...new Set(categories)], reasons: [...reasons, "요청한 임대 유형과의 관련성이 낮음"] };
}
